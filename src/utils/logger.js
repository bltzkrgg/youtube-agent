'use strict';

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Ensure log directory exists
fs.mkdirSync(config.paths.logs, { recursive: true });

// Standard error format: { agent, step, error_message, stack, timestamp }
const errorFormat = format((info) => {
  if (info.error instanceof Error) {
    info.error_message = info.error.message;
    info.stack = info.error.stack;
    delete info.error;
  }
  return info;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: format.combine(
    errorFormat(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    // Console output — human readable
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, agent, step, ...rest }) => {
          const agentStr = agent ? `[${agent}]` : '';
          const stepStr = step ? `[${step}]` : '';
          const extra = Object.keys(rest).length
            ? ' ' + JSON.stringify(rest)
            : '';
          return `${timestamp} ${level} ${agentStr}${stepStr} ${message}${extra}`;
        })
      ),
    }),

    // Rotating file — all levels
    new DailyRotateFile({
      dirname: config.paths.logs,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),

    // Error-only file
    new DailyRotateFile({
      dirname: config.paths.logs,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      zippedArchive: true,
    }),
  ],
});

module.exports = logger;
