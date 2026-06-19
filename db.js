import pkg from 'pg';
const { Pool } = pkg;

// Configuração da ligação ao PostgreSQL utilizando as Variáveis de Ambiente do Easypanel
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

// Monitorização de erros na ligação para evitar que o servidor caia silenciosamente
pool.on('error', (err, client) => {
    console.error('🚨 Erro inesperado no PostgreSQL:', err);
});

// Teste inicial de conexão ao arrancar o servidor
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL. Verifique as credenciais no Easypanel.', err.message);
    } else {
        console.log('✅ Conectado ao PostgreSQL com sucesso! Micro-CRM Operacional.');
    }
});

export default pool;
