// index.js

// =====================================================
// IMPORTAÇÕES E CONFIGURAÇÃO INICIAL
// =====================================================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config(); // Para usar variáveis de ambiente

const app = express();
app.use(cors());
app.use(express.json());

// Porta onde a API vai rodar
const PORT = process.env.PORT || 4000;

// Token de autenticação (use variável de ambiente em produção)
const API_TOKEN = process.env.API_TOKEN || '4f9d8e7c6b5a4d3c2f1e0a9b8c7d6e5f4a3b2c1d';

// =====================================================
// CONFIGURAÇÃO DO BANCO DE DADOS (SUPABASE)
// =====================================================

let pool;
const dbConfig = {};

// Método 1: Tenta usar a Connection String (preferencial)
if (process.env.DATABASE_URL) {
    console.log("🔌 Tentando conectar usando DATABASE_URL...");
    dbConfig.connectionString = process.env.DATABASE_URL;
} 
// Método 2: Fallback para variáveis de ambiente individuais (como no código original)
else if (process.env.SUPABASE_HOST) {
    console.log("🔌 DATABASE_URL não encontrada. Tentando conectar com variáveis de ambiente separadas...");
    dbConfig.host = process.env.SUPABASE_HOST;
    dbConfig.port = process.env.SUPABASE_PORT || 5432;
    dbConfig.user = process.env.SUPABASE_USER;
    dbConfig.password = process.env.SUPABASE_PASSWORD;
    dbConfig.database = process.env.SUPABASE_DB || 'postgres';
}

// Validação final: Se nenhuma configuração foi encontrada, encerra a aplicação.
if (!dbConfig.connectionString && !dbConfig.host) {
    console.error('❌ ERRO FATAL: Nenhuma configuração de banco de dados encontrada.');
    console.error('Por favor, configure a variável de ambiente DATABASE_URL ou as variáveis SUPABASE_HOST, SUPABASE_USER, etc.');
    process.exit(1);
}

// Adiciona configuração SSL obrigatória para o Supabase
dbConfig.ssl = {
    rejectUnauthorized: false
};

pool = new Pool(dbConfig);


// Teste de conexão
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar ao Supabase:', err.stack);
    if (err.message.includes('SSL')) {
        console.info('💡 DICA: Erros de SSL com o Supabase geralmente são resolvidos garantindo que a connection string termine com "?sslmode=require".');
    }
  } else {
    console.log('✅ Conectado ao banco de dados Supabase com sucesso!');
    release();
  }
});

// =====================================================
// INICIALIZAÇÃO E ESTRUTURA DO BANCO DE DADOS
// =====================================================

/**
 * Garante que as tabelas necessárias (merchants, pedidos, pedidos_events)
 * e seus respectivos campos e índices existam no banco de dados.
 * Esta função é idempotente e pode ser executada com segurança na inicialização.
 */
async function initDb() {
  const client = await pool.connect();
  try {
    console.log('🔄 Inicializando estrutura do banco de dados...');
    await client.query('BEGIN');

    // 1) Tabela 'merchants': Armazena os dados de cada estabelecimento.
    // O ID é a chave primária (UUID) fornecida pela plataforma parceira.
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

    // 2) Tabela 'pedidos': Armazena os pedidos, agora com referência ao merchant.
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

    // 3) Tabela 'pedidos_events': Armazena o histórico de eventos de cada pedido.
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

    // 4) Criação de Índices para otimizar consultas
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

/**
 * Insere ou atualiza os dados do merchant de teste (Pizzaria Capriolli)
 * para garantir que os endpoints de teste funcionem corretamente.
 */
async function seedInitialMerchant() {
    console.log('🌱 Verificando e inserindo dados do merchant de teste...');
    const merchantData = {
        id: '19f40604-e725-4fd4-ad06-aae8aaa8e213',
        code: '81193',
        name: 'Pizzaria Capriolli',
        url: 'Capriolli',
        connectDbId: '-2147463250',
        roles: ['consumer-rede', 'mobile', 'fiscal', 'menudino-completo', 'connect', 'taxa-implantacao-treinamento']
    };

    try {
        await pool.query(`
            INSERT INTO merchants (id, code, name, url, connect_db_id, roles, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (id) DO UPDATE SET
                code = EXCLUDED.code,
                name = EXCLUDED.name,
                url = EXCLUDED.url,
                connect_db_id = EXCLUDED.connect_db_id,
                roles = EXCLUDED.roles,
                updated_at = NOW();
        `, [merchantData.id, merchantData.code, merchantData.name, merchantData.url, merchantData.connectDbId, JSON.stringify(merchantData.roles)]);
        console.log('✅ Merchant de teste "Pizzaria Capriolli" garantido no banco.');
    } catch (error) {
        console.error('❌ Erro ao inserir merchant de teste:', error);
    }
}


// Executa a inicialização do DB ao iniciar a aplicação
initDb().then(seedInitialMerchant).catch(err => {
  console.error('🚨 Erro fatal ao inicializar o banco:', err);
  process.exit(1);
});

// =====================================================
// MIDDLEWARE DE AUTENTICAÇÃO
// =====================================================
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token !== API_TOKEN) {
    console.warn(`[AUTH] Tentativa de acesso com token inválido: ${token}`);
    return res.status(401).json({
      statusCode: 401,
      reasonPhrase: 'Token inválido ou ausente'
    });
  }
  next();
};

// =====================================================
// ROTAS PÚBLICAS E DE DEBUG
// =====================================================

app.get('/', (req, res) => {
  res.json({
    mensagem: 'API Consumer Integration funcionando!',
    versao: '2.0.2 (Conexão Flexível)',
    database: 'Supabase',
    endpoints: {
      polling: 'GET /api/polling',
      detalhes: 'GET /api/order/:orderId',
      envioDetalhes: 'POST /api/order/details',
      atualizacaoStatus: 'POST /api/order/status'
    }
  });
});

// Rota para depurar todos os merchants cadastrados
app.get('/debug/merchants', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM merchants ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar merchants:', error);
        res.status(500).json({ erro: error.message });
    }
});

app.get('/debug/pedidos', async (req, res) => {
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

app.get('/debug/eventos', async (req, res) => {
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
        UPDATE pedidos_events SET consumed = TRUE WHERE event_id = ANY($1::int[])
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
      'SELECT dados FROM pedidos WHERE id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ item: null, statusCode: 404, reasonPhrase: 'Pedido não encontrado' });
    }

    // Gera um evento de que os detalhes foram solicitados
    await pool.query(`
      INSERT INTO pedidos_events(order_id, event_type)
      VALUES($1, 'ORDER_DETAILS_REQUESTED')
    `, [orderId]);

    // Retorna o JSON completo do pedido, que já contém o objeto 'merchant'
    res.json({ item: rows[0].dados, statusCode: 0, reasonPhrase: null });
  } catch (error) {
    console.error(`Erro buscando pedido ${req.params.orderId}:`, error);
    res.status(500).json({ item: null, statusCode: 500, reasonPhrase: error.message });
  }
});

// 3) ENDPOINT PARA RECEBER DETALHES DO PEDIDO (DO CONSUMER)
app.post('/api/order/details', async (req, res) => {
  const pedido = req.body;
  const client = await pool.connect();

  try {
    // Validação básica do payload
    if (!pedido.Id || !pedido.Merchant || !pedido.Merchant.Id) {
      return res.status(400).json({ statusCode: 400, reasonPhrase: 'ID do pedido e dados do Merchant são obrigatórios' });
    }

    await client.query('BEGIN');

    // Etapa 1: Inserir ou atualizar o Merchant (UPSERT)
    const merchant = pedido.Merchant;
    await client.query(`
        INSERT INTO merchants (id, name, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = NOW();
    `, [merchant.Id, merchant.Name || 'Nome não informado']);

    // Etapa 2: Inserir ou atualizar o Pedido, associando ao Merchant
    await client.query(`
      INSERT INTO pedidos (id, merchant_id, dados, status, updated_at)
      VALUES ($1, $2, $3, 'PLACED', NOW())
      ON CONFLICT (id) DO UPDATE SET
        dados = EXCLUDED.dados,
        status = CASE WHEN pedidos.status IS NULL THEN 'PLACED' ELSE pedidos.status END,
        updated_at = NOW();
    `, [pedido.Id, merchant.Id, pedido]);

    // Etapa 3: Registrar o evento de criação/envio do pedido
    await client.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status)
      VALUES($1, 'CREATED', 'PLACED')
    `, [pedido.Id]);
    
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

// 4) ENDPOINT DE ATUALIZAÇÃO DE STATUS
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

    // Atualiza o status na tabela de pedidos
    await client.query(`
      UPDATE pedidos SET status = $1, updated_at = NOW() WHERE id = $2
    `, [status, orderId]);

    // Insere o evento de atualização de status
    await client.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status)
      VALUES($1, 'status_updated', $2)
    `, [orderId, status]);

    await client.query('COMMIT');

    res.json({
      statusCode: 0,
      reasonPhrase: `Status do pedido ${orderId} alterado para '${status}'.`
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
app.post('/test/criar-pedido', async (req, res) => {
  const client = await pool.connect();
  try {
    const pedidoId = `TEST-${Date.now()}`;
    const merchantId = '19f40604-e725-4fd4-ad06-aae8aaa8e213'; // ID da Pizzaria Capriolli

    const pedidoTeste = {
      Id: pedidoId,
      Type: "DELIVERY",
      DisplayId: Math.floor(Math.random() * 9999).toString(),
      SalesChannel: "PARTNER",
      CreatedAt: new Date().toISOString(),
      Merchant: { 
          Id: merchantId, 
          Name: "Pizzaria Capriolli" 
      },
      Items: [{
        Id: `ITEM-${Date.now()}`,
        Name: "Pizza Teste Capriolli",
        ExternalCode: "112",
        Quantity: 1,
        UnitPrice: { Value: 35.00, Currency: "BRL" },
        TotalPrice: { Value: 35.00, Currency: "BRL" }
      }],
      Total: { ItemsPrice: {Value: 35.00}, OtherFees: {Value: 5.00}, OrderAmount: {Value: 40.00} },
      Customer: { Id: `CUSTOMER-${Date.now()}`, Name: "Cliente Teste", Phone: { Number: "11999999999" } },
      Payments: { Methods: [{ Method: "CREDIT", Type: "ONLINE", Value: 40.00 }], Prepaid: 40.00, Pending: 0 },
      Delivery: {
        Mode: "DEFAULT", DeliveredBy: "MERCHANT",
        DeliveryAddress: {
          StreetName: "Rua Teste", StreetNumber: "123",
          Neighborhood: "Bairro Teste", City: "São Paulo",
          State: "SP", PostalCode: "01234-567", Country: "BR"
        }
      }
    };
    
    await client.query('BEGIN');

    // Insere o pedido
    await client.query(`
      INSERT INTO pedidos (id, merchant_id, dados, status) VALUES ($1, $2, $3, 'PLACED')
    `, [pedidoTeste.Id, pedidoTeste.Merchant.Id, pedidoTeste]);

    // Insere o evento de criação
    await client.query(`
      INSERT INTO pedidos_events(order_id, event_type, new_status) VALUES($1, 'created', 'PLACED')
    `, [pedidoTeste.Id]);
    
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
// INICIALIZAÇÃO DO SERVIDOR E GRACEFUL SHUTDOWN
// =====================================================
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.stack);
  res.status(500).json({
    statusCode: 500,
    reasonPhrase: 'Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 API pronta e rodando em http://0.0.0.0:${PORT}`);
  console.log(`🗄️  Banco de dados: Supabase`);
  console.log(`🔑 Token de autenticação: Bearer ${API_TOKEN}`);
  console.log(`\n📝 Endpoints da API:`);
  console.log(`   - GET  /api/polling`);
  console.log(`   - GET  /api/order/:orderId`);
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
