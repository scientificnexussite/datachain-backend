import pkg from 'pg';
import chalk from 'chalk';

const { Pool } = pkg;

// Solves Issue #3: Single shared pool to prevent Connection Exhaustion on Railway
// Limitation 8 FIX: Added SSL configuration for Railway PostgreSQL external connections.
// Railway requires SSL; the connectionString alone does not enforce it in all environments.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Reduced from 200
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

pool.on('error', (err) => {
    console.error(chalk.red('[DB] Unexpected error on idle client'), err);
});

export default pool;
