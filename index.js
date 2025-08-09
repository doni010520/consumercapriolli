// index.js

// ==============================
// Imports e setup básico
// ==============================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 4000;
const API_TOKEN = process.env.API_TOKEN || '4f9d8e7c6b5a4d3c2f1e0a9b8c7d6e5f4a3b2c1d';
const DEV = process.env.NODE_ENV === 'development';

// ==============================
// Banco (Supabase via pg.Pool)
// ==============================
const pool = new Pool({
  host: process.env.SUPABASE_HOST || 'seu-projeto.supabase.co',
  port: process.env.SUPABASE_PORT || 6543,
  database: process.env.SUPABASE_DB || 'postgres',
  user: process.env.SUPABASE_USER || 'postgres.seu-projeto-id',
  password: process.env.SUPABASE_PASSWORD || 'sua-senha-do-supabase',
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Evita crash em shutdown/idle client
pool.on('error', (err) => {
  console.error('⚠️  Erro no pool (idle client):', err?.message || err);
});

// Teste de conexão (seguro)
(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Conectado ao banco de dados Supabase com sucesso!');
    client.release();
  } catch (err) {
    console.error('❌ Erro ao conectar ao Supabase:', err.stack || err);
  }
})();

// ==============================
// Helpers
// ==============================
function sendError(res, httpCode, reason, err) {
  return res.status(httpCode).json({
    statusCode: httpCode,
    reasonPhrase: reason,
    error: DEV && err ? (err.message || String(err)) : undefined,
  });
}

// Auth compatível com várias formas de envio
function authenticate(req, res, next) {
  const h = req.headers || {};
  const auth = h.authorization || '';

  let provided = null;

  // 1) Padrão antigo: "Authorization: Bearer <TOKEN>"
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) provided = bearerMatch[1];

  // 2) "Authorization: <TOKEN>" (sem "Bearer")
  if (!provided && auth && !/\s/.test(auth)) provided = auth;

  // 3) Headers alternativos
  if (!provided) {
    provided =
      h['x-access-token'] ||
      h['x-token'] ||
      h['token'] ||
      h['consumer-token'] ||
      null;
  }

  // 4) Query string (?token=)
  if (!provided && req.query && req.query.token) provided = req.query.token;

  const ok = provided && provided === API_TOKEN;

  if (!ok) {
    if (DEV) {
      console.log('Auth falhou', {
        provided: provided || null,
        authorization: h.authorization,
        xAccess: h['x-access-token'],
        xToken: h['x-token'],
        token: h['token'],
        q: req.query?.token,
      });
    }
    return res
      .status(401)
      .json({ statusCode: 401, reasonPhrase: 'Token inválido ou ausente' });
  }

  next();
}

// ==============================
// Init do banco (DDL + índices)
// ==============================
async function initDb() {
  try {
    console.log('🔄 Inicializando estrutura do banco de dados...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id TEXT PRIMARY KEY,
        dados JSONB NOT NULL,          -- JSON no padrão camelCase do Consumer
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE pedidos
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_events (
        event_id SERIAL PRIMARY KEY,
        order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        new_status TEXT,
        consumed BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE pedidos_events
      ADD COLUMN IF NOT EXISTS consumed BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Índices
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
      CREATE INDEX IF NOT EXISTS idx_pedidos_created_at ON pedidos(created_at);

      CREATE INDEX IF NOT EXISTS idx_events_consumed ON pedidos_events(consumed);
      CREATE INDEX IF NOT EXISTS idx_events_order_id ON pedidos_events(order_id);
      CREATE INDEX IF NOT EXISTS idx_events_consumed_eventid ON pedidos_events(consumed, event_id);
    `);

    console.log('✅ Estrutura do banco inicializada com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao inicializar estrutura do banco:', err);
    process.exit(1);
  }
}
initDb();

// ==============================
// Rotas públicas
// ==============================
app.get('/', (req, res) => {
  res.json({
    mensagem: 'API Consumer Integration funcionando!',
    versao: '1.3.0',
    database: 'Supabase',
    endpoints: {
      polling: 'GET /api/polling',
      detalhes: 'GET /api/order/:orderId',
      envioDetalhes: 'POST /api/order/details',
      atualizacaoStatus: 'POST /api/order/status',
    },
  });
});

// Healthcheck simples
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.get('/debug/pedidos', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, status, created_at, updated_at
      FROM pedidos
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    return sendError(res, 500, 'Erro ao buscar pedidos', error);
  }
});

app.get('/debug/eventos', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM pedidos_events
      ORDER BY event_id DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar eventos:', error);
    return sendError(res, 500, 'Erro ao buscar eventos', error);
  }
});

// ==============================
// Rotas protegidas (Consumer)
// ==============================
app.use('/api', authenticate);

// 1) POLLING
app.get('/api/polling', async (req, res) => {
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
      await pool.query(
        `UPDATE pedidos_events SET consumed = TRUE WHERE event_id = ANY($1::int[])`,
        [ids]
      );
    }

    return res.json({ items: rows, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('Erro no polling:', error);
    return sendError(res, 500, 'Erro no polling', error);
  }
});

// 2) GET DETALHES DO PEDIDO
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rows } = await pool.query(
      'SELECT dados, status FROM pedidos WHERE id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Pedido não encontrado');
    }

    // registra ODR
    await pool.query(
      `INSERT INTO pedidos_events(order_id, event_type) VALUES($1, 'ORDER_DETAILS_REQUESTED')`,
      [orderId]
    );

    // retorna exatamente o JSON salvo (deve estar em camelCase conforme Consumer)
    return res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('Erro buscando pedido:', error);
    return sendError(res, 500, 'Erro ao buscar pedido', error);
  }
});

// 3) POST RECEBER DETALHES
// Aceita 3 formatos de body:
//  A) pedido completo (camelCase) contendo "id"
//  B) { Id: "...", ...pedidoCamelCase }
//  C) { id: "...", status: "...?", dados: { ...pedidoCamelCase } }
app.post('/api/order/details', async (req, res) => {
  try {
    const body = req.body || {};

    const orderId =
      body.Id ||
      body.id ||
      (body.dados && (body.dados.id || body.dados.Id));

    if (!orderId) {
      return sendError(res, 400, 'ID do pedido é obrigatório');
    }

    const pedidoDados = body.dados ? body.dados : body;

    await pool.query(
      `
      INSERT INTO pedidos (id, dados, status, updated_at)
      VALUES ($1, $2, COALESCE($3, 'PLACED'), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        dados = EXCLUDED.dados,
        status = COALESCE(pedidos.status, EXCLUDED.status, 'PLACED'),
        updated_at = NOW()
      `,
      [orderId, pedidoDados, body.status || null]
    );

    await pool.query(
      `INSERT INTO pedidos_events(order_id, event_type, new_status)
       VALUES($1, 'ORDER_DETAILS_SENT', 'PLACED')`,
      [orderId]
    );

    return res.json({
      statusCode: 0,
      reasonPhrase: `${orderId} enviado com sucesso.`,
    });
  } catch (error) {
    console.error('Erro salvando detalhes:', error);
    return sendError(res, 500, 'Erro ao salvar detalhes do pedido', error);
  }
});

// 4) POST ATUALIZAÇÃO DE STATUS
app.post('/api/order/status', async (req, res) => {
  try {
    const { orderId, status, justification } = req.body || {};
    if (!orderId || !status) {
      return sendError(res, 400, 'orderId e status são obrigatórios');
    }

    const { rowCount } = await pool.query(
      'SELECT 1 FROM pedidos WHERE id = $1',
      [orderId]
    );
    if (rowCount === 0) {
      return sendError(res, 404, 'Pedido não encontrado');
    }

    await pool.query(
      `UPDATE pedidos SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, orderId]
    );

    await pool.query(
      `INSERT INTO pedidos_events(order_id, event_type, new_status)
       VALUES($1, 'status_updated', $2)`,
      [orderId, status]
    );

    return res.json({
      statusCode: 0,
      reasonPhrase: `${orderId} alterado para '${status}': ${
        justification || 'Status atualizado'
      }.`,
    });
  } catch (error) {
    console.error('Erro atualizando status:', error);
    return sendError(res, 500, 'Erro ao atualizar status', error);
  }
});

// ==============================
// Rotas de teste
// ==============================
app.post('/test/criar-pedido', async (req, res) => {
  try {
    const pedidoTeste = {
      id: `TEST-${Date.now()}`,
      orderType: 'DELIVERY',
      displayId: Math.floor(Math.random() * 9999).toString(),
      salesChannel: 'PARTNER',
      createdAt: new Date().toISOString(),
      merchant: {
        id: '2eff44c8-ff06-4507-8233-e3f72c4e59af',
        name: 'Teste - Consumer Integration',
      },
      items: [
        {
          id: `ITEM-${Date.now()}`,
          name: 'Pizza Teste',
          externalCode: '112',
          quantity: 1,
          unitPrice: 35.0,
          totalPrice: 35.0,
        },
      ],
      total: { subTotal: 35.0, deliveryFee: 5.0, orderAmount: 40.0 },
      customer: {
        id: `CUSTOMER-${Date.now()}`,
        name: 'Cliente Teste',
        phone: { number: '11999999999' },
      },
      payments: {
        methods: [
          { method: 'CREDIT', type: 'ONLINE', value: 40.0, currency: 'BRL' },
        ],
        prepaid: 40.0,
        pending: 0,
      },
      delivery: {
        mode: 'DEFAULT',
        deliveredBy: 'MERCHANT',
        deliveryAddress: {
          streetName: 'Rua Teste',
          streetNumber: '123',
          neighborhood: 'Bairro Teste',
          city: 'São Paulo',
          state: 'SP',
          postalCode: '01234-567',
          country: 'BR',
        },
      },
    };

    await pool.query(
      `INSERT INTO pedidos (id, dados, status)
       VALUES ($1, $2, 'PLACED')
       ON CONFLICT (id) DO NOTHING`,
      [pedidoTeste.id, pedidoTeste]
    );

    await pool.query(
      `INSERT INTO pedidos_events(order_id, event_type, new_status)
       VALUES($1, 'CREATED', 'PLACED')`,
      [pedidoTeste.id]
    );

    return res.json({
      mensagem: 'Pedido de teste criado com sucesso',
      pedidoId: pedidoTeste.id,
    });
  } catch (error) {
    console.error('Erro ao criar pedido de teste:', error);
    return sendError(res, 500, 'Erro ao criar pedido de teste', error);
  }
});

// ==============================
// Erro global
// ==============================
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.stack);
  return sendError(res, 500, 'Erro interno do servidor', err);
});

// ==============================
// Start
// ==============================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API rodando em http://0.0.0.0:${PORT}`);
  console.log(`🗄️  Banco de dados: Supabase`);
  console.log(
    `🔐 Token de autenticação: ${API_TOKEN ? '[definido]' : 'NÃO DEFINIDO'}`
  );
  console.log(
    `📝 Endpoints: GET /api/polling | GET /api/order/:orderId | POST /api/order/details | POST /api/order/status`
  );
  console.log(
    `🔧 Debug: GET /debug/pedidos | GET /debug/eventos | POST /test/criar-pedido | GET /healthz`
  );
});

// ==============================
// Graceful shutdown
// ==============================
function gracefulExit(signal) {
  console.log(`${signal} recebido. Fechando conexões...`);
  pool
    .end()
    .then(() => {
      console.log('Pool de conexões fechado.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Erro ao fechar pool:', err?.message || err);
      process.exit(0);
    });
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));
