
// index.js

// Importando bibliotecas
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config(); // Para usar variáveis de ambiente

// Criando a aplicação
const app = express();
app.use(cors());
app.use(express.json());

// Porta onde a API vai rodar
const PORT = process.env.PORT || 4000;

// Token de autenticação (use variável de ambiente em produção)
const API_TOKEN = process.env.API_TOKEN || '4f9d8e7c6b5a4d3c2f1e0a9b8c7d6e5f4a3b2c1d';

// =====================================================
// CONFIGURAÇÃO DO SUPABASE
// =====================================================
// Opção 1: Usando variáveis de ambiente (RECOMENDADO)
const pool = new Pool({
  host: process.env.SUPABASE_HOST || 'seu-projeto.supabase.co',
  port: process.env.SUPABASE_PORT || 6543,
  database: process.env.SUPABASE_DB || 'postgres',
  user: process.env.SUPABASE_USER || 'postgres.seu-projeto-id',
  password: process.env.SUPABASE_PASSWORD || 'sua-senha-do-supabase',
  ssl: {
    rejectUnauthorized: false // Necessário para Supabase
  },
  // Configurações adicionais para melhor performance
  max: 20, // Máximo de conexões no pool
  idleTimeoutMillis: 30000, // Tempo de inatividade antes de fechar conexão
  connectionTimeoutMillis: 2000, // Tempo máximo para estabelecer conexão
});

// Opção 2: Usando Connection String (alternativa)
// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL || 'postgresql://postgres.seu-projeto-id:sua-senha@seu-projeto.supabase.co:6543/postgres',
//   ssl: {
//     rejectUnauthorized: false
//   }
// });

// Teste de conexão
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar ao Supabase:', err.stack);
  } else {
    console.log('✅ Conectado ao banco de dados Supabase com sucesso!');
    release();
  }
});

// Inicializa o banco: cria tabelas e garante colunas em esquemas legados
async function initDb() {
  try {
    console.log('🔄 Inicializando estrutura do banco de dados...');
    
    // 1) Cria a tabela 'pedidos' se não existir, já incluindo created_at e updated_at
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id TEXT PRIMARY KEY,
        dados JSONB NOT NULL,
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "pedidos" verificada/criada');

    // 2) Garante que, em bancos legados, a coluna 'updated_at' exista
    await pool.query(`
      ALTER TABLE pedidos
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    // 3) Cria a tabela 'pedidos_events' se não existir, já incluindo 'consumed'
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
    console.log('✅ Tabela "pedidos_events" verificada/criada');

    // 4) Garante que, em bancos legados, a coluna 'consumed' exista
    await pool.query(`
      ALTER TABLE pedidos_events
      ADD COLUMN IF NOT EXISTS consumed BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // 5) Criar índices para melhor performance (opcional mas recomendado)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
      CREATE INDEX IF NOT EXISTS idx_pedidos_created_at ON pedidos(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_consumed ON pedidos_events(consumed);
      CREATE INDEX IF NOT EXISTS idx_events_order_id ON pedidos_events(order_id);
    `);
    console.log('✅ Índices verificados/criados');

    console.log('✅ Estrutura do banco inicializada com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao inicializar estrutura do banco:', err);
    throw err;
  }
}

initDb().catch(err => {
  console.error('Erro fatal ao inicializar o banco:', err);
  process.exit(1);
});

// Middleware de autenticação
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token !== API_TOKEN) {
    console.log('Token inválido recebido:', token);
    return res.status(401).json({
      statusCode: 401,
      reasonPhrase: 'Token inválido ou ausente'
    });
  }
  next();
};

// =====================================================
// ROTAS PÚBLICAS
// =====================================================

app.get('/', (req, res) => {
  res.json({ 
    mensagem: 'API Consumer Integration funcionando!',
    versao: '1.0.0',
    database: 'Supabase',
    endpoints: {
      polling: 'GET /api/polling',
      detalhes: 'GET /api/order/:orderId',
      envioDetalhes: 'POST /api/order/details',
      atualizacaoStatus: 'POST /api/order/status'
    }
  });
});

app.get('/debug/pedidos', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, status, created_at, updated_at
      FROM pedidos
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    res.status(500).json({ erro: error.message });
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
    res.status(500).json({ erro: error.message });
  }
});

// =====================================================
// ROTAS PROTEGIDAS DA API DO CONSUMER
// =====================================================
app.use('/api', authenticate);

// 1) ENDPOINT DE POLLING
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
      const ids = rows.map(r => r.id);
      await pool.query(`
        UPDATE pedidos_events
        SET consumed = TRUE
        WHERE event_id = ANY($1::int[])
      `, [ids]);
    }

    res.json({ items: rows, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('Erro no polling:', error);
    res.status(500).json({ items: [], statusCode: 1, reasonPhrase: error.message });
  }
});

// 2) ENDPOINT DE DETALHES DO PEDIDO
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rows } = await pool.query(
      'SELECT dados, status FROM pedidos WHERE id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type)
      VALUES($1, 'ORDER_DETAILS_REQUESTED')
    `, [orderId]);

    res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('Erro buscando pedido:', error);
    res.status(500).json({ item: null, statusCode: 500, reasonPhrase: error.message });
  }
});

// 3) ENDPOINT PARA RECEBER DETALHES DO PEDIDO
app.post('/api/order/details', async (req, res) => {
  try {
    const pedido = req.body;
    if (!pedido.Id) {
      return res.status(400).json({ statusCode: 400, reasonPhrase: 'ID do pedido é obrigatório' });
    }

    await pool.query(`
      INSERT INTO pedidos (id, dados, status, updated_at)
      VALUES ($1, $2, 'PLACED', NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        dados = EXCLUDED.dados,
        status = CASE WHEN pedidos.status IS NULL THEN 'PLACED' ELSE pedidos.status END,
        updated_at = NOW()
    `, [pedido.Id, pedido]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status)
      VALUES($1, 'ORDER_DETAILS_SENT', 'PLACED')
    `, [pedido.Id]);

    res.json({ statusCode: 0, reasonPhrase: `${pedido.Id} enviado com sucesso.` });
  } catch (error) {
    console.error('Erro salvando detalhes:', error);
    res.status(500).json({ statusCode: 500, reasonPhrase: error.message });
  }
});

// 4) ENDPOINT DE ATUALIZAÇÃO DE STATUS
app.post('/api/order/status', async (req, res) => {
  try {
    const { orderId, status, justification } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({ statusCode: 400, reasonPhrase: 'orderId e status são obrigatórios' });
    }

    const { rowCount } = await pool.query('SELECT 1 FROM pedidos WHERE id = $1', [orderId]);
    if (rowCount === 0) {
      return res.status(404).json({ statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    await pool.query(`
      UPDATE pedidos
      SET status = $1, updated_at = NOW()
      WHERE id = $2
    `, [status, orderId]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status)
      VALUES($1, 'status_updated', $2)
    `, [orderId, status]);

    res.json({
      statusCode: 0,
      reasonPhrase: `${orderId} alterado para '${status}': ${justification || 'Status atualizado'}.`
    });
  } catch (error) {
    console.error('Erro atualizando status:', error);
    res.status(500).json({ statusCode: 500, reasonPhrase: error.message });
  }
});

// ROTAS DE TESTE
app.post('/test/criar-pedido', async (req, res) => {
  try {
    const pedidoTeste = {
      id: `TEST-${Date.now()}`,
      orderType: "DELIVERY",
      displayId: Math.floor(Math.random() * 9999).toString(),
      salesChannel: "PARTNER",
      createdAt: new Date().toISOString(),
      merchant: { id: "2eff44c8-ff06-4507-8233-e3f72c4e59af", name: "Teste - Consumer Integration" },
      items: [{
        id: `ITEM-${Date.now()}`,
        name: "Pizza Teste",
        externalCode: "112",
        quantity: 1,
        unitPrice: 35.00,
        totalPrice: 35.00
      }],
      total: { itemsPrice: 35.00, deliveryFee: 5.00, orderAmount: 40.00 },
      customer: { id: `CUSTOMER-${Date.now()}`, name: "Cliente Teste", phone: { number: "11999999999" } },
      payments: { methods: [{ method: "CREDIT", type: "ONLINE", value: 40.00 }], prepaid: 40.00, pending: 0 },
      delivery: {
        mode: "DEFAULT", deliveredBy: "MERCHANT",
        deliveryAddress: {
          streetName: "Rua Teste", streetNumber: "123",
          neighborhood: "Bairro Teste", city: "São Paulo",
          state: "SP", postalCode: "01234-567", country: "BR"
        }
      }
    };

    await pool.query(`
      INSERT INTO pedidos (id, dados, status)
      VALUES ($1, $2, 'PLACED')
    `, [pedidoTeste.id, pedidoTeste]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status)
      VALUES($1, 'created', 'PLACED')
    `, [pedidoTeste.id]);

    res.json({ mensagem: 'Pedido de teste criado com sucesso', pedidoId: pedidoTeste.id });
  } catch (error) {
    console.error('Erro ao criar pedido de teste:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Tratamento de erro global
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.stack);
  res.status(500).json({ 
    statusCode: 500, 
    reasonPhrase: 'Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Inicia o servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API rodando em http://0.0.0.0:${PORT}`);
  console.log(`🗄️  Banco de dados: Supabase`);
  console.log(`✅ Token de autenticação: Bearer ${API_TOKEN}`);
  console.log(`📝 Endpoints da API:`);
  console.log(`   - GET  /api/polling`);
  console.log(`   - GET  /api/order/:orderId`);
  console.log(`   - POST /api/order/details`);
  console.log(`   - POST /api/order/status`);
  console.log(`🔧 Debug:`);
  console.log(`   - GET  /debug/pedidos`);
  console.log(`   - GET  /debug/eventos`);
  console.log(`   - POST /test/criar-pedido`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido. Fechando conexões...');
  pool.end(() => {
    console.log('Pool de conexões fechado.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT recebido. Fechando conexões...');
  pool.end(() => {
    console.log('Pool de conexões fechado.');
    process.exit(0);
  });
});
