const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.use('/api/instances', require('./routes/instances'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/images', require('./routes/images'));
app.use('/api/modules', require('./routes/modules'));
app.use('/api/db', require('./routes/db'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`redroid-forge listening on :${PORT}`);
  // Checks (never applies) whether a newer combinations database exists: on
  // open and once a day. Can be turned off with REDROID_FORGE_DB_CHECK=0.
  require('./lib/knownDbUpdate').startScheduler();
});

// Last safety net: a bug in a single request cannot bring down the whole process
// (and with it the management of ALL the running instances).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
