#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  err => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 2;
  }
);
