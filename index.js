// index.js

// =====================================================
// IMPORTAÇÕES E CONFIGURAÇÃO INICIAL
// =====================================================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
// --- ALIAS/REWRITE para funcionar SEM o prefixo /api ---
// (mantém uma única implementação: reescreve e deixa seguir para /api/*)

function qs(req) {
  return req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
}

// Polling (GET /polling -> /api/polling)
app.get('/polling', (req, res, next) => {
  req.url = '/api/polling' + qs(req);
  next();
});

// Detalhes via query (GET /order?orderId=... -> /api/order?orderId=...)
app.get('/order', (req, res, next) => {
  req.url = '/api/order' + qs(req);
  next();
});

// Detalhes via path (GET /order/:orderId -> /api/order/:orderId)
app.get('/order/:orderId', (req, res, next) => {
  req.url = `/api/order/${encodeURIComponent(req.params.orderId)}` + qs(req);
  next();
});

// Status (POST /order/status -> /api/order/status)
app.post('/order/status', (req, res, next) => {
  req.url = '/api/order/status' + qs(req);
  next();
});

// Envio de detalhes (POST /order/details -> /api/order/details)
app.post('/order/details', (req, res, next) => {
  req.url = '/api/order/details' + qs(req);
  next();
});

// Placeholder encodado (GET /order/%7BorderId%7D -> /api/order/%7BorderId%7D)
app.get('/order/%7BorderId%7D', (req, res, next) => {
  req.url = '/api/order/%7BorderId%7D' + qs(req);
  next();
});

// 🔎 Log de entrada (antes do auth) — ajuda a ver se a requisição chega
app.use((req, _res, next) => {
  console.log(`[IN] ${req.method} ${req.originalUrl} ua="${req.headers['user-agent'] || ''}" ip=${req.ip}`);
  next();
});

// Porta e Token
const PORT = process.env.PORT || 4000;
let API_TOKEN = process.env.API_TOKEN || '123456';

// =====================================================
// CONFIGURAÇÃO DO BANCO (SUPABASE / POSTGRES)
// =====================================================
let pool;
const dbConfig = {};

if (process.env.DATABASE_URL) {
  console.log('🔌 Tentando conectar usando DATABASE_URL...');
  dbConfig.connectionString = process.env.DATABASE_URL;
} else if (process.env.SUPABASE_HOST) {
  console.log('🔌 DATABASE_URL não encontrada. Tentando conectar com variáveis separadas...');
  dbConfig.host = process.env.SUPABASE_HOST;
  dbConfig.port = process.env.SUPABASE_PORT || 5432;
  dbConfig.user = process.env.SUPABASE_USER;
  dbConfig.password = process.env.SUPABASE_PASSWORD;
  dbConfig.database = process.env.SUPABASE_DB || 'postgres';
} else {
  console.error('❌ ERRO FATAL: Nenhuma configuração de banco de dados encontrada.');
  process.exit(1);
}

// SSL para Supabase
dbConfig.ssl = { rejectUnauthorized: false };
pool = new Pool(dbConfig);

// Teste de conexão
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar ao Supabase:', err.stack);
    if (err.message?.includes('SSL')) {
      console.info('💡 DICA: use "?sslmode=require" na connection string.');
    }
  } else {
    console.log('✅ Conectado ao banco de dados Supabase com sucesso!');
    release();
  }
});

// =====================================================
// INICIALIZAÇÃO DO BANCO (TABELAS / ÍNDICES)
// =====================================================
async function initDb() {
  const client = await pool.connect();
  try {
    console.log('🔄 Inicializando estrutura do banco de dados...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS merchants (
        id UUID PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        url TEXT,
        connect_db_id TEXT,
        roles JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "merchants" verificada/criada.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id TEXT PRIMARY KEY,
        merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
        dados JSONB NOT NULL,
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "pedidos" verificada/criada.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos_events (
        event_id SERIAL PRIMARY KEY,
        order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        new_status TEXT,
        consumed BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "pedidos_events" verificada/criada.');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_merchant_id ON pedidos(merchant_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_created_at ON pedidos(created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_consumed ON pedidos_events(consumed);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_order_id ON pedidos_events(order_id);`);
    console.log('✅ Índices verificados/criados.');

    await client.query('COMMIT');
    console.log('✅ Estrutura do banco inicializada com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao inicializar estrutura do banco:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Seed com os dados **oficiais** do Consumer (dump enviado)
async function seedInitialMerchant() {
  console.log('🌱 Verificando e inserindo dados do merchant de teste (oficial do Consumer)...');
  const merchantData = {
    // ⚠️ Alinhado com o "Access Token" do Consumer
    id: '19f406fa-e725-4fd4-ad06-aae8aaa8e213',
    code: '81193',
    name: 'Pizzaria Capriolli Limitada', // pode manter "Pizzaria Capriolli" se preferir
    url: 'capriolli',                    // minúsculo, como no Consumer
    connectDbId: '-2147463250',
    roles: [
      'consumer-rede',
      'mobile',
      'fiscal',
      'menudino-completo',
      'connect',
      'taxa-implantacao-treinamento',
      'Merchant',
      'Premium'
    ],
  };

  try {
    await pool.query(
      `
      INSERT INTO merchants (id, code, name, url, connect_db_id, roles, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        url  = EXCLUDED.url,
        connect_db_id = EXCLUDED.connect_db_id,
        roles = EXCLUDED.roles,
        updated_at = NOW();
      `,
      [
        merchantData.id,
        merchantData.code,
        merchantData.name,
        merchantData.url,
        merchantData.connectDbId,
        JSON.stringify(merchantData.roles),
      ]
    );
    console.log('✅ Merchant alinhado com o Consumer garantido no banco.');
  } catch (error) {
    console.error('❌ Erro ao inserir merchant de teste:', error);
  }
}

initDb()
  .then(seedInitialMerchant)
  .catch((err) => {
    console.error('🚨 Erro fatal ao inicializar o banco:', err);
    process.exit(1);
  });

// =====================================================
// MIDDLEWARE DE AUTENTICAÇÃO (robusto + workarounds)
// =====================================================
const authenticate = (req, res, next) => {
  const h = req.headers;
  const rawAuth = h['authorization'];

  // Suporta: "Bearer xxx", "Token xxx" ou token cru no Authorization
  let fromAuth =
    rawAuth?.startsWith('Bearer ') ? rawAuth.slice(7) :
    rawAuth?.startsWith('Token ')  ? rawAuth.slice(6) :
    rawAuth;

  let token =
    (fromAuth && fromAuth.trim()) ||
    h['x-api-key'] ||
    h['x-access-token'] ||
    req.query.token ||
    (req.body && req.body.token);

  // Workaround 1: token vindo como "<token>"
  if (token && token.startsWith('<') && token.endsWith('>')) {
    token = token.slice(1, -1).trim();
  }

  // Workaround 2: alguns clientes enviam "token/ORDERID"
  if (token && token.includes('/')) {
    const [maybeToken, ...rest] = token.split('/');
    req._orderIdFromTokenFallback = rest.join('/');
    token = maybeToken;
  }

  // Validação
  if (token !== API_TOKEN) {
    if (process.env.DEBUG_AUTH === '1') {
      console.warn(
        `[AUTH] ${req.method} ${req.path} header="${rawAuth || 'undefined'}" ` +
        `recebido="${(req.query.token || fromAuth || token || 'undefined')}"`
      );
    } else {
      console.warn(`[AUTH] ${req.method} ${req.path} token inválido ou ausente`);
    }
    return res.status(401).json({ statusCode: 401, reasonPhrase: 'Token inválido ou ausente' });
  }
  next();
};

// =====================================================
// ROTAS PÚBLICAS E DEBUG
// =====================================================
app.get('/', (_req, res) => {
  res.json({
    mensagem: 'API Consumer Integration funcionando!',
    versao: '2.0.4 (Merchant alinhado + logger de entrada)',
    database: 'Supabase',
    endpoints: {
      health: 'GET /healthz',
      polling: 'GET /api/polling',
      detalhes: 'GET /api/order/:orderId  |  GET /api/order?orderId=...',
      envioDetalhes: 'POST /api/order/details',
      atualizacaoStatus: 'POST /api/order/status',
    },
  });
});

// Health check público
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: '2.0.4', time: new Date().toISOString() });
});

// Debug
app.get('/debug/merchants', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM merchants ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar merchants:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.get('/debug/pedidos', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.status, p.merchant_id, m.name as merchant_name, p.created_at, p.updated_at
      FROM pedidos p
      LEFT JOIN merchants m ON p.merchant_id = m.id
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.get('/debug/eventos', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM pedidos_events ORDER BY event_id DESC LIMIT 50
    `);
  res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar eventos:', error);
    res.status(500).json({ erro: error.message });
  }
});

// =====================================================
// ROTAS PROTEGIDAS
// =====================================================
app.use('/api', authenticate);

// 1) POLLING
app.get('/api/polling', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pe.event_id::text AS id,
        pe.order_id AS "orderId",
        pe.timestamp AS "createdAt",
        CASE
          WHEN UPPER(pe.event_type) = 'CREATED' THEN 'PLACED'
          WHEN UPPER(pe.event_type) = 'ORDER_DETAILS_REQUESTED' THEN 'ORDER_DETAILS_REQUESTED'
          WHEN UPPER(pe.new_status) IN ('CONFIRMED','CONFIRMADO') THEN 'CONFIRMED'
          WHEN UPPER(pe.new_status) IN ('CANCELLED','CANCELADO') THEN 'CANCELLED'
          WHEN UPPER(pe.new_status) = 'DISPATCHED' THEN 'DISPATCHED'
          WHEN UPPER(pe.new_status) = 'READY_TO_PICKUP' THEN 'READY_TO_PICKUP'
          WHEN UPPER(pe.new_status) = 'CONCLUDED' THEN 'CONCLUDED'
          ELSE UPPER(pe.event_type)
        END AS "fullCode",
        CASE
          WHEN UPPER(pe.event_type) = 'CREATED' THEN 'PLC'
          WHEN UPPER(pe.event_type) = 'ORDER_DETAILS_REQUESTED' THEN 'ODR'
          WHEN UPPER(pe.new_status) IN ('CONFIRMED','CONFIRMADO') THEN 'CFM'
          WHEN UPPER(pe.new_status) IN ('CANCELLED','CANCELADO') THEN 'CAN'
          WHEN UPPER(pe.new_status) = 'DISPATCHED' THEN 'DSP'
          WHEN UPPER(pe.new_status) = 'READY_TO_PICKUP' THEN 'RTP'
          WHEN UPPER(pe.new_status) = 'CONCLUDED' THEN 'CON'
          ELSE 'UNK'
        END AS "code"
      FROM pedidos_events pe
      WHERE pe.consumed = FALSE
      ORDER BY pe.event_id ASC
      LIMIT 10
    `);

    if (rows.length > 0) {
      const ids = rows.map((r) => Number(r.id));
      await pool.query('UPDATE pedidos_events SET consumed = TRUE WHERE event_id = ANY($1::int[])', [ids]);
    }

    res.json({ items: rows, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('Erro no polling:', error);
    res.status(500).json({ items: [], statusCode: 1, reasonPhrase: error.message });
  }
});

// 2a) DETALHES — workaround para /api/order/%7BorderId%7D
app.get('/api/order/%7BorderId%7D', async (req, res) => {
  const orderId = req._orderIdFromTokenFallback || req.query.orderId || null;
  if (!orderId) return res.status(400).json({ item: null, statusCode: 400, reasonPhrase: 'orderId ausente' });

  try {
    const { rows } = await pool.query('SELECT dados FROM pedidos WHERE id = $1', [orderId]);
    if (!rows.length) return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });

    await pool.query(`INSERT INTO pedidos_events(order_id, event_type) VALUES($1, 'ORDER_DETAILS_REQUESTED')`, [orderId]);
    return res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (e) {
    console.error('Erro /api/order/%7BorderId%7D:', e);
    return res.status(500).json({ item: null, statusCode: 500, reasonPhrase: e.message });
  }
});

// 2b) DETALHES — formato query: /api/order?orderId=...
app.get('/api/order', async (req, res) => {
  const orderId = req.query.orderId || req._orderIdFromTokenFallback || null;
  if (!orderId) return res.status(400).json({ item: null, statusCode: 400, reasonPhrase: 'orderId ausente' });

  try {
    const { rows } = await pool.query('SELECT dados FROM pedidos WHERE id = $1', [orderId]);
    if (!rows.length) return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });

    await pool.query(`INSERT INTO pedidos_events(order_id, event_type) VALUES($1, 'ORDER_DETAILS_REQUESTED')`, [orderId]);
    return res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (e) {
    console.error('Erro /api/order:', e);
    return res.status(500).json({ item: null, statusCode: 500, reasonPhrase: e.message });
  }
});

// 2c) DETALHES — formato “bonito”: /api/order/:orderId
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rows } = await pool.query('SELECT dados FROM pedidos WHERE id = $1', [orderId]);

    if (!rows.length) {
      return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    await pool.query(`INSERT INTO pedidos_events(order_id, event_type) VALUES($1, 'ORDER_DETAILS_REQUESTED')`, [orderId]);
    res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error(`Erro buscando pedido ${req.params.orderId}:`, error);
    res.status(500).json({ item: null, statusCode: 500, reasonPhrase: error.message });
  }
});

// 3) RECEBER DETALHES — POST /api/order/details
app.post('/api/order/details', async (req, res) => {
  const pedido = req.body;
  const client = await pool.connect();

  try {
    if (!pedido.Id || !pedido.Merchant || !pedido.Merchant.Id) {
      return res.status(400).json({ statusCode: 400, reasonPhrase: 'ID do pedido e dados do Merchant são obrigatórios' });
    }

    await client.query('BEGIN');

    const merchant = pedido.Merchant;
    await client.query(
      `
      INSERT INTO merchants (id, name, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = NOW();
      `,
      [merchant.Id, merchant.Name || 'Nome não informado']
    );

    await client.query(
      `
      INSERT INTO pedidos (id, merchant_id, dados, status, updated_at)
      VALUES ($1, $2, $3, 'PLACED', NOW())
      ON CONFLICT (id) DO UPDATE SET
        dados = EXCLUDED.dados,
        status = CASE WHEN pedidos.status IS NULL THEN 'PLACED' ELSE pedidos.status END,
        updated_at = NOW();
      `,
      [pedido.Id, merchant.Id, pedido]
    );

    await client.query(
      `INSERT INTO pedidos_events(order_id, event_type, new_status) VALUES($1, 'CREATED', 'PLACED')`,
      [pedido.Id]
    );

    await client.query('COMMIT');
    res.status(201).json({ statusCode: 0, reasonPhrase: `Pedido ${pedido.Id} recebido com sucesso.` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro salvando detalhes do pedido:', error);
    res.status(500).json({ statusCode: 500, reasonPhrase: error.message });
  } finally {
    client.release();
  }
});

// 4) ATUALIZAÇÃO DE STATUS — POST /api/order/status
app.post('/api/order/status', async (req, res) => {
  const { orderId, status, justification } = req.body;
  if (!orderId || !status) {
    return res.status(400).json({ statusCode: 400, reasonPhrase: 'orderId e status são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rowCount } = await client.query('SELECT 1 FROM pedidos WHERE id = $1', [orderId]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    await client.query(`UPDATE pedidos SET status = $1, updated_at = NOW() WHERE id = $2`, [status, orderId]);

    await client.query(
      `INSERT INTO pedidos_events(order_id, event_type, new_status) VALUES($1, 'status_updated', $2)`,
      [orderId, status]
    );

    await client.query('COMMIT');

    res.json({
      statusCode: 0,
      reasonPhrase: `Status do pedido ${orderId} alterado para '${status}'${justification ? `: ${justification}` : ''}.`,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Erro atualizando status para o pedido ${orderId}:`, error);
    res.status(500).json({ statusCode: 500, reasonPhrase: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// ROTAS DE TESTE
// =====================================================
app.post('/test/criar-pedido', async (_req, res) => {
  const client = await pool.connect();
  try {
    const pedidoId = `TEST-${Date.now()}`;
    const merchantId = '19f406fa-e725-4fd4-ad06-aae8aaa8e213'; // alinhado com o Consumer

    const pedidoTeste = {
      Id: pedidoId,
      Type: 'DELIVERY',
      DisplayId: String(Math.floor(Math.random() * 9999)).padStart(4, '0'),
      SalesChannel: 'PARTNER',
      CreatedAt: new Date().toISOString(),
      Merchant: { Id: merchantId, Name: 'Pizzaria Capriolli' },
      Items: [
        {
          Id: `ITEM-${Date.now()}`,
          Name: 'Pizza Teste Capriolli',
          ExternalCode: '112',
          Quantity: 1,
          UnitPrice: { Value: 35.0, Currency: 'BRL' },
          TotalPrice: { Value: 35.0, Currency: 'BRL' },
        },
      ],
      Total: { ItemsPrice: { Value: 35.0 }, OtherFees: { Value: 5.0 }, OrderAmount: { Value: 40.0 } },
      Customer: { Id: `CUSTOMER-${Date.now()}`, Name: 'Cliente Teste', Phone: { Number: '11999999999' } },
      Payments: { Methods: [{ Method: 'CREDIT', Type: 'ONLINE', Value: 40.0 }], Prepaid: 40.0, Pending: 0 },
      Delivery: {
        Mode: 'DEFAULT',
        DeliveredBy: 'MERCHANT',
        DeliveryAddress: {
          StreetName: 'Rua Teste',
          StreetNumber: '123',
          Neighborhood: 'Bairro Teste',
          City: 'São Paulo',
          State: 'SP',
          PostalCode: '01234-567',
          Country: 'BR',
        },
      },
    };

    await client.query('BEGIN');
    await client.query(`INSERT INTO pedidos (id, merchant_id, dados, status) VALUES ($1, $2, $3, 'PLACED')`, [
      pedidoTeste.Id,
      pedidoTeste.Merchant.Id,
      pedidoTeste,
    ]);
    await client.query(`INSERT INTO pedidos_events(order_id, event_type, new_status) VALUES($1, 'created', 'PLACED')`, [
      pedidoTeste.Id,
    ]);
    await client.query('COMMIT');

    res.status(201).json({ mensagem: 'Pedido de teste criado com sucesso', pedidoId: pedidoTeste.Id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar pedido de teste:', error);
    res.status(500).json({ erro: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// INICIALIZAÇÃO DO SERVIDOR E SHUTDOWN
// =====================================================
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err.stack);
  res.status(500).json({
    statusCode: 500,
    reasonPhrase: 'Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 API pronta e rodando em http://0.0.0.0:${PORT}`);
  console.log(`🗄️  Banco de dados: Supabase`);
  console.log(`🔑 API_TOKEN len=${API_TOKEN ? String(API_TOKEN).length : 0} (não exibido)`);
  console.log(`\n📝 Endpoints da API:`);
  console.log(`   - GET  /healthz`);
  console.log(`   - GET  /api/polling`);
  console.log(`   - GET  /api/order/:orderId`);
  console.log(`   - GET  /api/order?orderId=...`);
  console.log(`   - GET  /api/order/%7BorderId%7D   (workaround)`);
  console.log(`   - POST /api/order/details`);
  console.log(`   - POST /api/order/status`);
  console.log(`\n🔧 Debug:`);
  console.log(`   - GET  /debug/merchants`);
  console.log(`   - GET  /debug/pedidos`);
  console.log(`   - GET  /debug/eventos`);
  console.log(`   - POST /test/criar-pedido`);
});

const gracefulShutdown = (signal) => {
  console.log(`\n${signal} recebido. Fechando conexões...`);
  server.close(() => {
    console.log('Servidor HTTP fechado.');
    pool.end(() => {
      console.log('Pool de conexões com o banco de dados fechado.');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
