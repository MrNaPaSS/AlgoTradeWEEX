const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || err.status || 500;
    const code = err.code || 'INTERNAL_ERROR';

    logger.error('Request failed', {
        method: req.method,
        path: req.path,
        statusCode,
        code,
        message: err.message,
        stack: err.stack
    });

    res.status(statusCode).json({
        success: false,
        error: {
            code,
            message: statusCode === 500 ? 'Internal server error' : err.message,
            requestId: req.requestId
        }
    });
}

module.exports = errorHandler;
