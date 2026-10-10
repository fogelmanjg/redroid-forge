#!/usr/bin/env node
'use strict';

// Kept for the people and the docs that use the old name: it is `sdk-extract.js gapps ...`.
process.argv.splice(2, 0, 'gapps');
require('./sdk-extract');
