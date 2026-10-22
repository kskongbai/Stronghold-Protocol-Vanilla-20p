# Start the no-plugin 20p build on its own port so it never shares the main server's 3000/admin.
$env:PORT = '3001'
node server/index.js
