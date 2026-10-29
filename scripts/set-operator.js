// Crea un operador del panel o cambia su contraseña en la base de datos.
// Uso: npm run operator -- <usuario> <contraseña>
import { Store } from '../src/db/store.js';
import { OperatorAuth } from '../src/auth/operators.js';
import { config } from '../src/config.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Uso: npm run operator -- <usuario> <contraseña>');
  process.exit(1);
}
const store = new Store(config.dbPath);
new OperatorAuth(store.db).setOperator(username, password);
store.close();
console.log(`Operador "${username}" guardado en ${config.dbPath}`);
