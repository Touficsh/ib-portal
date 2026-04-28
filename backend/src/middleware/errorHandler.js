/**
 * Global Express Error Handler
 *
 * Catches all unhandled errors from routes and middleware.
 * Security: 5xx errors return a generic "Internal server error" message to
 * prevent leaking stack traces or internal details to clients.
 * 4xx errors pass through the original error message (user-facing).
 *
 * @param {Error} err - The error object (may have a .status property)
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function errorHandler(err, req, res, next) {
  console.error(err.stack);
  const status = err.status || 500;
  // Only expose error message for client errors (4xx); hide internals for server errors (5xx)
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}
