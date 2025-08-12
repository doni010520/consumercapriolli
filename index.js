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
// CONFIGURAÇÃO DO MERCHANT (ESTABELECIMENTO)
// =====================================================
const MERCHANT_CONFIG = {
  MerchantID: process.env.MERCHANT_ID || '19f406fa-e725-4fd4-ad06-aae8aaa8e213',
  MerchantCode: process.env.MERCHANT_CODE || '81193',
  MerchantName: process.env.MERCHANT_NAME || 'Pizzaria Capriolli',
  MerchantUrl: process.env.MERCHANT_URL || 'capriolli',
  ConnectDbId: process.env.CONNECT_DB_ID || '-2147463250',
  Roles: (process.env.MERCHANT_ROLES || 'consumer-rede,mobile,fiscal,menudino-completo,connect,taxa-implantacao-treina').split(',')
};

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
    console.log('🏪 Merchant configurado:', MERCHANT_CONFIG.MerchantName);
    release();
  }
});

// Inicializa o banco: cria tabelas e garante colunas em esquemas legados
async function initDb() {
  try {
    console.log('🔄 Inicializando estrutura do banco de dados...');
    
    // 1) Cria a tabela 'pedidos' se não existir, incluindo campos do merchant
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id TEXT PRIMARY KEY,
        dados JSONB NOT NULL,
        status TEXT,
        merchant_id TEXT,
        merchant_code TEXT,
        merchant_name TEXT,
        merchant_url TEXT,
        connect_db_id TEXT,
        roles TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "pedidos" verificada/criada');

    // 2) Garante que, em bancos legados, as colunas do merchant existam
    await pool.query(`
      ALTER TABLE pedidos
      ADD COLUMN IF NOT EXISTS merchant_id TEXT,
      ADD COLUMN IF NOT EXISTS merchant_code TEXT,
      ADD COLUMN IF NOT EXISTS merchant_name TEXT,
      ADD COLUMN IF NOT EXISTS merchant_url TEXT,
      ADD COLUMN IF NOT EXISTS connect_db_id TEXT,
      ADD COLUMN IF NOT EXISTS roles TEXT[],
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    // 3) Cria a tabela 'pedidos_events' se não existir
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_events (
        event_id SERIAL PRIMARY KEY,
        order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        new_status TEXT,
        merchant_id TEXT,
        merchant_code TEXT,
        consumed BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Tabela "pedidos_events" verificada/criada');

    // 4) Garante que, em bancos legados, as colunas existam
    await pool.query(`
      ALTER TABLE pedidos_events
      ADD COLUMN IF NOT EXISTS merchant_id TEXT,
      ADD COLUMN IF NOT EXISTS merchant_code TEXT,
      ADD COLUMN IF NOT EXISTS consumed BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // 5) Criar índices para melhor performance (opcional mas recomendado)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
      CREATE INDEX IF NOT EXISTS idx_pedidos_created_at ON pedidos(created_at);
      CREATE INDEX IF NOT EXISTS idx_pedidos_merchant_id ON pedidos(merchant_id);
      CREATE INDEX IF NOT EXISTS idx_events_consumed ON pedidos_events(consumed);
      CREATE INDEX IF NOT EXISTS idx_events_order_id ON pedidos_events(order_id);
      CREATE INDEX IF NOT EXISTS idx_events_merchant_id ON pedidos_events(merchant_id);
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

// =====================================================
// MONITORAMENTO E DEBUG
// =====================================================
let requestCount = 0;
let failedAuthCount = 0;
let successAuthCount = 0;
let lastRequestTime = Date.now();
const requestLog = [];

// Middleware de autenticação APRIMORADO com DEBUG
const authenticate = (req, res, next) => {
  requestCount++;
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  lastRequestTime = now;
  
  // Log detalhado da requisição
  const requestInfo = {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip || req.connection.remoteAddress,
    authorization: req.headers.authorization,
    userAgent: req.headers['user-agent'],
    timestamp: new Date().toISOString(),
    timeSinceLastRequest: timeSinceLastRequest + 'ms'
  };
  
  // Adiciona ao log (mantém últimas 100 requisições)
  requestLog.push(requestInfo);
  if (requestLog.length > 100) requestLog.shift();
  
  // Log a cada 10 requisições
  if (requestCount % 10 === 0) {
    console.log('📊 Estatísticas de Requisições:', {
      total: requestCount,
      sucessos: successAuthCount,
      falhas: failedAuthCount,
      ultimaRequisicao: timeSinceLastRequest + 'ms atrás'
    });
  }
  
  // Primeira tentativa (mais detalhada)
  if (requestCount === 1 || requestCount % 50 === 0) {
    console.log('📨 Detalhes da requisição:', requestInfo);
  }
  
  // Verifica o token de várias formas
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.split(' ')[1];
  const directToken = authHeader; // Caso venha direto sem "Bearer"
  const alternativeToken = req.headers['x-api-token'] || req.headers['token'] || req.headers['api-token'];
  
  // Debug de tokens (apenas nas primeiras requisições)
  if (failedAuthCount < 5) {
    console.log('🔑 Debug de autenticação:', {
      receivedAuthHeader: authHeader,
      bearerToken: bearerToken ? bearerToken.substring(0, 10) + '...' : 'null',
      directToken: directToken ? directToken.substring(0, 10) + '...' : 'null',
      alternativeToken: alternativeToken ? alternativeToken.substring(0, 10) + '...' : 'null',
      expectedToken: API_TOKEN.substring(0, 10) + '...'
    });
  }
  
  // Verifica se algum dos tokens está correto
  if (bearerToken === API_TOKEN || 
      directToken === API_TOKEN || 
      alternativeToken === API_TOKEN ||
      authHeader === `Bearer ${API_TOKEN}`) {
    successAuthCount++;
    console.log('✅ Autenticação bem-sucedida! #' + successAuthCount);
    next();
  } else {
    failedAuthCount++;
    
    // Log detalhado apenas nas primeiras 5 falhas
    if (failedAuthCount <= 5) {
      console.log('❌ Falha na autenticação #' + failedAuthCount, {
        url: req.originalUrl,
        receivedToken: bearerToken || directToken || alternativeToken || 'NENHUM TOKEN',
        headers: req.headers
      });
      
      if (failedAuthCount === 5) {
        console.log('⚠️ Suprimindo logs de falha de autenticação após 5 tentativas...');
      }
    }
    
    return res.status(401).json({
      statusCode: 401,
      reasonPhrase: 'Token inválido ou ausente',
      debug: process.env.NODE_ENV === 'development' ? {
        receivedToken: bearerToken || directToken || alternativeToken,
        expectedFormat: 'Bearer YOUR_TOKEN',
        alternativeHeaders: ['x-api-token', 'token', 'api-token']
      } : undefined
    });
  }
};

// =====================================================
// ROTAS PÚBLICAS
// =====================================================

app.get('/', (req, res) => {
  res.json({ 
    mensagem: 'API Consumer Integration funcionando!',
    versao: '1.0.0',
    database: 'Supabase',
    merchant: {
      id: MERCHANT_CONFIG.MerchantID,
      code: MERCHANT_CONFIG.MerchantCode,
      name: MERCHANT_CONFIG.MerchantName,
      url: MERCHANT_CONFIG.MerchantUrl,
      roles: MERCHANT_CONFIG.Roles
    },
    endpoints: {
      polling: 'GET /api/polling',
      detalhes: 'GET /api/order/:orderId',
      envioDetalhes: 'POST /api/order/details',
      atualizacaoStatus: 'POST /api/order/status'
    },
    stats: {
      totalRequests: requestCount,
      successfulAuth: successAuthCount,
      failedAuth: failedAuthCount
    }
  });
});

app.get('/debug/stats', (req, res) => {
  res.json({
    estatisticas: {
      totalRequisicoes: requestCount,
      autenticacoesComSucesso: successAuthCount,
      autenticacoesFalhadas: failedAuthCount,
      taxaSucesso: successAuthCount > 0 ? ((successAuthCount / (successAuthCount + failedAuthCount)) * 100).toFixed(2) + '%' : '0%'
    },
    ultimasRequisicoes: requestLog.slice(-10), // Últimas 10 requisições
    merchant: MERCHANT_CONFIG
  });
});

app.get('/debug/merchant', (req, res) => {
  res.json({
    MerchantID: MERCHANT_CONFIG.MerchantID,
    MerchantCode: MERCHANT_CONFIG.MerchantCode,
    MerchantName: MERCHANT_CONFIG.MerchantName,
    MerchantUrl: MERCHANT_CONFIG.MerchantUrl,
    ConnectDbId: MERCHANT_CONFIG.ConnectDbId,
    Roles: MERCHANT_CONFIG.Roles
  });
});

app.get('/debug/pedidos', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, status, merchant_id, merchant_code, merchant_name, created_at, updated_at
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
    console.log('🔄 Polling executado com sucesso!');
    
    const { rows } = await pool.query(`
      SELECT
        pe.event_id::text AS id,
        pe.order_id AS "orderId",
        pe.merchant_id AS "merchantId",
        pe.merchant_code AS "merchantCode",
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
      console.log(`📦 ${rows.length} eventos encontrados para processar`);
      const ids = rows.map(r => r.id);
      await pool.query(`
        UPDATE pedidos_events
        SET consumed = TRUE
        WHERE event_id = ANY($1::int[])
      `, [ids]);
    }

    res.json({ items: rows, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('❌ Erro no polling:', error);
    res.status(500).json({ items: [], statusCode: 1, reasonPhrase: error.message });
  }
});

// 2) ENDPOINT DE DETALHES DO PEDIDO
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log(`📋 Buscando detalhes do pedido: ${orderId}`);
    
    const { rows } = await pool.query(
      'SELECT dados, status, merchant_id, merchant_code, merchant_name, merchant_url, connect_db_id, roles FROM pedidos WHERE id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      console.log(`⚠️ Pedido não encontrado: ${orderId}`);
      return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    // Adiciona informações do merchant aos dados do pedido
    const pedidoComMerchant = {
      ...rows[0].dados,
      merchant: {
        ...rows[0].dados.merchant,
        MerchantID: rows[0].merchant_id || MERCHANT_CONFIG.MerchantID,
        MerchantCode: rows[0].merchant_code || MERCHANT_CONFIG.MerchantCode,
        MerchantName: rows[0].merchant_name || MERCHANT_CONFIG.MerchantName,
        MerchantUrl: rows[0].merchant_url || MERCHANT_CONFIG.MerchantUrl,
        ConnectDbId: rows[0].connect_db_id || MERCHANT_CONFIG.ConnectDbId,
        Roles: rows[0].roles || MERCHANT_CONFIG.Roles
      }
    };

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, merchant_id, merchant_code)
      VALUES($1, 'ORDER_DETAILS_REQUESTED', $2, $3)
    `, [orderId, MERCHANT_CONFIG.MerchantID, MERCHANT_CONFIG.MerchantCode]);

    console.log(`✅ Detalhes do pedido ${orderId} retornados com sucesso`);
    res.json({ item: pedidoComMerchant, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error('❌ Erro buscando pedido:', error);
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

    console.log(`📥 Recebendo detalhes do pedido: ${pedido.Id}`);

    // Extrai ou usa configurações default do merchant
    const merchantData = pedido.merchant || {};
    const merchantId = merchantData.MerchantID || merchantData.id || MERCHANT_CONFIG.MerchantID;
    const merchantCode = merchantData.MerchantCode || MERCHANT_CONFIG.MerchantCode;
    const merchantName = merchantData.MerchantName || merchantData.name || MERCHANT_CONFIG.MerchantName;
    const merchantUrl = merchantData.MerchantUrl || MERCHANT_CONFIG.MerchantUrl;
    const connectDbId = merchantData.ConnectDbId || MERCHANT_CONFIG.ConnectDbId;
    const roles = merchantData.Roles || MERCHANT_CONFIG.Roles;

    await pool.query(`
      INSERT INTO pedidos (id, dados, status, merchant_id, merchant_code, merchant_name, merchant_url, connect_db_id, roles, updated_at)
      VALUES ($1, $2, 'PLACED', $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        dados = EXCLUDED.dados,
        status = CASE WHEN pedidos.status IS NULL THEN 'PLACED' ELSE pedidos.status END,
        merchant_id = EXCLUDED.merchant_id,
        merchant_code = EXCLUDED.merchant_code,
        merchant_name = EXCLUDED.merchant_name,
        merchant_url = EXCLUDED.merchant_url,
        connect_db_id = EXCLUDED.connect_db_id,
        roles = EXCLUDED.roles,
        updated_at = NOW()
    `, [pedido.Id, pedido, merchantId, merchantCode, merchantName, merchantUrl, connectDbId, roles]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status, merchant_id, merchant_code)
      VALUES($1, 'ORDER_DETAILS_SENT', 'PLACED', $2, $3)
    `, [pedido.Id, merchantId, merchantCode]);

    console.log(`✅ Pedido ${pedido.Id} salvo com sucesso`);
    res.json({ statusCode: 0, reasonPhrase: `${pedido.Id} enviado com sucesso.` });
  } catch (error) {
    console.error('❌ Erro salvando detalhes:', error);
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

    console.log(`🔄 Atualizando status do pedido ${orderId} para ${status}`);

    const { rows } = await pool.query('SELECT merchant_id, merchant_code FROM pedidos WHERE id = $1', [orderId]);
    if (rows.length === 0) {
      console.log(`⚠️ Pedido não encontrado: ${orderId}`);
      return res.status(404).json({ statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    const merchantId = rows[0].merchant_id || MERCHANT_CONFIG.MerchantID;
    const merchantCode = rows[0].merchant_code || MERCHANT_CONFIG.MerchantCode;

    await pool.query(`
      UPDATE pedidos
      SET status = $1, updated_at = NOW()
      WHERE id = $2
    `, [status, orderId]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status, merchant_id, merchant_code)
      VALUES($1, 'status_updated', $2, $3, $4)
    `, [orderId, status, merchantId, merchantCode]);

    console.log(`✅ Status do pedido ${orderId} atualizado para ${status}`);
    res.json({
      statusCode: 0,
      reasonPhrase: `${orderId} alterado para '${status}': ${justification || 'Status atualizado'}.`
    });
  } catch (error) {
    console.error('❌ Erro atualizando status:', error);
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
      merchant: { 
        id: MERCHANT_CONFIG.MerchantID,
        name: MERCHANT_CONFIG.MerchantName,
        MerchantID: MERCHANT_CONFIG.MerchantID,
        MerchantCode: MERCHANT_CONFIG.MerchantCode,
        MerchantName: MERCHANT_CONFIG.MerchantName,
        MerchantUrl: MERCHANT_CONFIG.MerchantUrl,
        ConnectDbId: MERCHANT_CONFIG.ConnectDbId,
        Roles: MERCHANT_CONFIG.Roles
      },
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
      INSERT INTO pedidos (id, dados, status, merchant_id, merchant_code, merchant_name, merchant_url, connect_db_id, roles)
      VALUES ($1, $2, 'PLACED', $3, $4, $5, $6, $7, $8)
    `, [
      pedidoTeste.id, 
      pedidoTeste, 
      MERCHANT_CONFIG.MerchantID,
      MERCHANT_CONFIG.MerchantCode,
      MERCHANT_CONFIG.MerchantName,
      MERCHANT_CONFIG.MerchantUrl,
      MERCHANT_CONFIG.ConnectDbId,
      MERCHANT_CONFIG.Roles
    ]);

    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status, merchant_id, merchant_code)
      VALUES($1, 'created', 'PLACED', $2, $3)
    `, [pedidoTeste.id, MERCHANT_CONFIG.MerchantID, MERCHANT_CONFIG.MerchantCode]);

    console.log(`🎉 Pedido de teste criado: ${pedidoTeste.id}`);
    res.json({ 
      mensagem: 'Pedido de teste criado com sucesso', 
      pedidoId: pedidoTeste.id,
      merchant: {
        id: MERCHANT_CONFIG.MerchantID,
        code: MERCHANT_CONFIG.MerchantCode,
        name: MERCHANT_CONFIG.MerchantName
      }
    });
  } catch (error) {
    console.error('❌ Erro ao criar pedido de teste:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Tratamento de erro global
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err.stack);
  res.status(500).json({ 
    statusCode: 500, 
    reasonPhrase: 'Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Inicia o servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`🚀 API rodando em http://0.0.0.0:${PORT}`);
  console.log(`🗄️  Banco de dados: Supabase`);
  console.log(`🏪 Merchant: ${MERCHANT_CONFIG.MerchantName} (${MERCHANT_CONFIG.MerchantCode})`);
  console.log(`🆔 MerchantID: ${MERCHANT_CONFIG.MerchantID}`);
  console.log(`🌐 MerchantUrl: ${MERCHANT_CONFIG.MerchantUrl}`);
  console.log(`🔑 Roles: ${MERCHANT_CONFIG.Roles.join(', ')}`);
  console.log(`✅ Token de autenticação: Bearer ${API_TOKEN}`);
  console.log('='.repeat(60));
  console.log(`📝 Endpoints da API:`);
  console.log(`   - GET  /api/polling`);
  console.log(`   - GET  /api/order/:orderId`);
  console.log(`   - POST /api/order/details`);
  console.log(`   - POST /api/order/status`);
  console.log('='.repeat(60));
  console.log(`🔧 Debug & Monitoramento:`);
  console.log(`   - GET  /              (Status geral)`);
  console.log(`   - GET  /debug/stats   (Estatísticas de requisições)`);
  console.log(`   - GET  /debug/merchant(Configuração do merchant)`);
  console.log(`   - GET  /debug/pedidos (Lista pedidos)`);
  console.log(`   - GET  /debug/eventos (Lista eventos)`);
  console.log(`   - POST /test/criar-pedido (Criar pedido teste)`);
  console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido. Fechando conexões...');
  console.log(`📊 Estatísticas finais: ${requestCount} requisições, ${successAuthCount} sucessos, ${failedAuthCount} falhas`);
  pool.end(() => {
    console.log('Pool de conexões fechado.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.l
