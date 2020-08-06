// Copyright (C) 2020 Scott Lamb <slamb@slamb.org>
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder('utf-8');
const blankLine = encoder.encode('\r\n');

const STATE_BOUNDARY = 0;
const STATE_HEADERS = 1;
const STATE_BODY = 2;

/**
 * Compares two TypedArray objects for equality.
 * @param {TypedArray} a
 * @param {TypedArray} b
 * @return {bool}
 */
function compareArrays(a, b) {
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Parses a Content-Type into a multipart boundary.
 * @param {string} contentType
 * @return {Uint8Array} boundary line, including preceding -- and trailing \r\n
 */
function getBoundary(contentType) {
  // Expects the form "multipart/...; boundary=...".
  // This is not a full MIME media type parser but should be good enough.
  const MULTIPART_TYPE = 'multipart/';
  const BOUNDARY_PARAM = '; boundary=';
  if (!contentType.startsWith(MULTIPART_TYPE)) {
    return null;
  }
  const i = contentType.indexOf(BOUNDARY_PARAM, MULTIPART_TYPE.length);
  if (i == -1) {
    return null;
  }
  return contentType.substring(i + BOUNDARY_PARAM.length);
}

/**
 * Creates a multipart stream.
 * @param {string} contentType A Content-Type header.
 * @param {ReadableStream} body The body of a HTTP response.
 * @return {ReadableStream} a stream of {headers: Headers, body: Uint8Array}
 *     objects.
 */
export default function multipartStream(contentType, body) {
  const reader = body.getReader();
  return new ReadableStream({
    async start(controller) {
      // Define the boundary.
      const boundaryStr = getBoundary(contentType);
      if (boundaryStr === null) {
        controller.error(Error('Invalid content type for multipart stream: ' +
                               contentType));
        return;
      }
      const midBoundary = encoder.encode('--' + boundaryStr + '\r\n');
      const endBoundary = encoder.encode('--' + boundaryStr + '--');
      let pos = 0;
      let buf = new Uint8Array(); // buf.slice(pos) has unprocessed data.
      let state = STATE_BOUNDARY;
      let headers = null; // non-null in STATE_HEADERS and STATE_BODY.
      let contentLength = null; // non-null in STATE_BODY.

      /**
       * Consumes all complete data in buf or raises an Error.
       * May leave incomplete data at buf.slice(pos).
       */
      function processBuf() {
        while (true) {
          switch (state) {
            case STATE_BOUNDARY:
              // Read blank lines (if any) then boundary.
              while (buf.length >= pos + blankLine.length &&
                     compareArrays(buf.slice(pos, pos + blankLine.length),
                         blankLine)) {
                pos += blankLine.length;
              }

              // Check that it starts with a boundary.
              if (buf.length < pos + midBoundary.length) {
                return;
              }

              if (!compareArrays(buf.slice(pos, pos + midBoundary.length),
                  midBoundary)) {
                if (compareArrays(buf.slice(pos, pos + endBoundary.length),
                    endBoundary)) {
                  /* end of file boundary */
                  state = STATE_BOUNDARY;
                  pos += endBoundary.length;
                  return;
                }
                throw new Error('bad part boundary');
              }
              pos += midBoundary.length;
              state = STATE_HEADERS;
              headers = new Headers();
              break;

            case STATE_HEADERS:
              const cr = buf.indexOf('\r'.charCodeAt(0), pos);
              if (cr == -1 || buf.length == cr + 1) {
                return;
              }
              if (buf[cr + 1] != '\n'.charCodeAt(0)) {
                throw new Error('bad part header line (CR without NL)');
              }
              const line = decoder.decode(buf.slice(pos, cr));
              pos = cr + 2;
              if (line == '') {
                contentLength = parseInt(headers.get('Content-Length'), 10);
                if (isNaN(contentLength)) {
                  throw new Error('missing/invalid part Content-Length');
                }
                state = STATE_BODY;
                break;
              }
              const colon = line.indexOf(':');
              const name = line.substring(0, colon);
              if (colon == line.length || line[colon + 1] != ' ') {
                throw new Error('bad part header line (no ": ")');
              }
              const value = line.substring(colon + 2);
              headers.append(name, value);
              break;

            case STATE_BODY:
              if (buf.length < pos + contentLength) {
                return;
              }
              const body = buf.slice(pos, pos + contentLength);
              pos += contentLength;
              controller.enqueue({
                headers: headers,
                body: body,
              });
              headers = null;
              contentLength = null;
              state = STATE_BOUNDARY;
              break;
          }
        }
      }

      while (true) {
        const {done, value} = await reader.read();
        let buffered = buf.length - pos;
        if (done) {
          const newlines = [10, 13];
          while (buffered > 0 && newlines.includes(buf[pos])){
            pos++;
            buffered--;
          }
          if (state != STATE_BOUNDARY || buffered > 0) {
            throw Error('multipart stream ended mid-part');
          }
          controller.close();
          return;
        }

        // Update buf.slice(pos) to include the new data from value.
        if (buffered == 0) {
          buf = value;
        } else {
          const newLen = buffered + value.length;
          const newBuf = new Uint8Array(newLen);
          newBuf.set(buf.slice(pos), 0);
          newBuf.set(value, buffered);
          buf = newBuf;
        }
        pos = 0;

        processBuf();
      }
    },
    cancel(reason) {
      return body.cancel(reason);
    },
  });
}
