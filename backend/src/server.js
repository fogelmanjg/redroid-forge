const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.use('/api/instances', require('./routes/instances'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/images', require('./routes/images'));
app.use('/api/modules', require('./routes/modules'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`redroid-forge escuchando en :${PORT}`);
});

// Última red: un bug en un solo request no puede tumbar el proceso entero
// (y con el, el manejo de TODAS las instancias corriendo).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
