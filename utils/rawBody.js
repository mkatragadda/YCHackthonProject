/**
 * Read Raw HTTP Request Body
 *
 * Returns the raw request body as a Buffer.
 * Essential for webhook signature verification, which requires
 * the exact byte-for-byte request body that was signed.
 *
 * Usage (in API route):
 *   export const config = { api: { bodyParser: false } };
 *
 *   const body = await getRawBody(req);  // Returns Buffer
 *   const json = JSON.parse(body);
 */

async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

module.exports = { getRawBody };
