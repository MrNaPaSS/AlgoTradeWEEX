const { nanoid } = require('nanoid');
const { runWithContext } = require('../utils/logger');

const HEADER = 'x-request-id';

function requestIdMiddleware(req, res, next) {
    const incoming = req.headers[HEADER];
    const requestId = typeof incoming === 'string' && incoming.length >= 6 && incoming.length <= 64
        ? incoming
        : nanoid(12);

    req.requestId = requestId;
    res.setHeader(HEADER, requestId);

    runWithContext({ requestId }, () => next());
}

module.exports = requestIdMiddleware;
module.exports.HEADER = HEADER;
