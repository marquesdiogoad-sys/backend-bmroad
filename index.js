import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from './db.js';
import { isaSystemInstruction } from './isaPrompt.js';

dotenv.config();
const app = express();

// --- CONFIGURAÇÃO DE CORS BLINDADA ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'] 
}));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ferramentas = [{
    functionDeclarations: [{
        name: "salvar_dados_crm",
        description: "Guarda as informações do lead. Chame silenciosamente quando extrair dados.",
        parameters: {
            type: "OBJECT",
            properties: {
                cnpj: { type: "STRING", description: "CNPJ da empresa (apenas números ou formato padrão)" },
                empresa: { type: "STRING", description: "Nome da empresa" },
                rota_origem: { type: "STRING", description: "Cidade/Estado de origem" },
                rota_destino: { type: "STRING", description: "Cidade/Estado de destino" },
                nome_contato: { type: "STRING", description: "Nome do cliente com quem está a falar" },
                telefone: { type: "STRING", description: "Telefone ou WhatsApp do cliente com DDD" },
                peso_carga: { type: "STRING", description: "Peso estimado da carga" },
                volume_carga: { type: "STRING", description: "Volume ou dimensões da carga" },
                valor_nf: { type: "NUMBER", description: "Valor da Nota Fiscal (apenas números)" },
                cotacao_finalizada: { type: "BOOLEAN", description: "MUDE PARA TRUE APENAS quando terminar de coletar a rota, carga e contato, OU se o cliente pedir para falar com humano." }
            }
        }
    }]
}];

// --- FUNÇÕES DE PADRONIZAÇÃO ROBUSTAS (CRM) ---
function formatarCNPJ(cnpj) {
    if (!cnpj) return null;
    const n = String(cnpj).replace(/\D/g, ''); 
    if (n.length !== 14) return cnpj; 
    return `${n.substring(0, 2)}.${n.substring(2, 5)}.${n.substring(5, 8)}/${n.substring(8, 12)}-${n.substring(12, 14)}`;
}

function formatarTelefone(tel) {
    if (!tel) return null;
    const n = String(tel).replace(/\D/g, '');
    if (n.length === 11) return `(${n.substring(0, 2)}) ${n.substring(2, 7)}-${n.substring(7, 11)}`; 
    if (n.length === 10) return `(${n.substring(0, 2)}) ${n.substring(2, 6)}-${n.substring(6, 10)}`; 
    return tel; 
}

function validarTelefoneBR(telefone) {
    if (!telefone) return true;
    const numeros = String(telefone).replace(/\D/g, '');
    if (numeros.length !== 10 && numeros.length !== 11) return false;
    const ddd = parseInt(numeros.substring(0, 2));
    if (ddd < 11 || ddd > 99) return false;
    if (numeros.length === 11 && numeros.charAt(2) !== '9') return false;
    const numeroSemDDD = numeros.substring(2);
    if (/^(\d)\1+$/.test(numeroSemDDD) || numeroSemDDD === '123456789' || numeroSemDDD === '12345678') return false;
    return true;
}

async function consultarCNPJ(cnpjOriginal) {
    if (!cnpjOriginal) return { valido: false, erro: "CNPJ é obrigatório." };
    const cnpjNumeros = String(cnpjOriginal).replace(/\D/g, '');
    if (cnpjNumeros.length !== 14) return { valido: false, erro: "O CNPJ precisa ter exatamente 14 números." };

    try {
        const res1 = await fetch(`https://publica.cnpj.ws/cnpj/${cnpjNumeros}`);
        if (res1.ok) { const data1 = await res1.json(); return { valido: true, razao_social: data1.razao_social }; }
    } catch (e) {}

    try {
        const res2 = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpjNumeros}`);
        if (res2.ok) {
            const data2 = await res2.json();
            if (data2.status === "ERROR") return { valido: false, erro: "CNPJ rejeitado pela Receita." };
            return { valido: true, razao_social: data2.nome };
        }
    } catch (e) {}

    try {
        const res3 = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNumeros}`);
        if (res3.ok) { const data3 = await res3.json(); return { valido: true, razao_social: data3.razao_social }; }
    } catch (e) {}

    return { valido: false, erro: "Instabilidade na verificação com a Receita." };
}

async function enviarAlertaWhatsApp(nome, empresa, telefone, necessidade) {
    const numero = "5511954937948";
    const apiKey = "8836652";
    const textoBruto = `🚨 *NOVO LEAD BM ROAD!*\n\n*Empresa:* ${empresa}\n*Contato:* ${nome}\n*Telefone:* ${telefone}\n*Demanda:* ${necessidade}\n\n🔥 _Acesse o CRM para ver os detalhes!_`;
    const textoCodificado = encodeURIComponent(textoBruto);
    try {
        const response = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${numero}&text=${textoCodificado}&apikey=${apiKey}`);
        if (response.ok) console.log("✅ WhatsApp disparado!");
    } catch (error) { console.error("🚨 Erro WhatsApp:", error); }
}

function isEmailCorporativo(email) {
    const provedoresGratuitos = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br', 'bol.com.br', 'uol.com.br', 'ig.com.br', 'icloud.com', 'msn.com'];
    const dominio = email.split('@')[1];
    if (!dominio) return false;
    return !provedoresGratuitos.includes(dominio.toLowerCase());
}

// ==========================================
// 🤖 ROTAS DE IA E FORMULÁRIOS
// ==========================================
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];
    const threadId = req.body.threadId || `sessao_${Date.now()}`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools: ferramentas, systemInstruction: isaSystemInstruction });
        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(userMessage);
        
        let cotacaoFinalizada = false;
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            if (call.name === "salvar_dados_crm") {
                const args = call.args;
                let mensagemParaIA = "Dados atualizados. Faça a próxima pergunta natural do funil.";
                let podeSalvar = true;

                if (args.telefone && !validarTelefoneBR(args.telefone)) { podeSalvar = false; mensagemParaIA = "ERRO DE VALIDAÇÃO: Telefone inválido."; }
                if (podeSalvar && args.cnpj) {
                    const validacaoCnpj = await consultarCNPJ(args.cnpj);
                    if (!validacaoCnpj.valido) { podeSalvar = false; mensagemParaIA = `ERRO DE VALIDAÇÃO: ${validacaoCnpj.erro}`; } 
                    else if (validacaoCnpj.razao_social) { args.empresa = validacaoCnpj.razao_social; }
                }

                if (podeSalvar) {
                    const valoresBD = [
                        formatarCNPJ(args.cnpj) ?? null, args.empresa ?? null, args.rota_origem ?? null, args.rota_destino ?? null,
                        args.nome_contato ?? null, formatarTelefone(args.telefone) ?? null, args.peso_carga ?? null, args.volume_carga ?? null,
                        args.valor_nf ?? null, threadId
                    ];

                    const resVerifica = await pool.query('SELECT id FROM leads_cotacoes WHERE thread_id = $1', [threadId]);
                    if (resVerifica.rows.length > 0) {
                        await pool.query(`UPDATE leads_cotacoes SET cnpj = COALESCE($1, cnpj), empresa = COALESCE($2, empresa), rota_origem = COALESCE($3, rota_origem), rota_destino = COALESCE($4, rota_destino), nome_contato = COALESCE($5, nome_contato), telefone = COALESCE($6, telefone), peso_carga = COALESCE($7, peso_carga), volume_carga = COALESCE($8, volume_carga), valor_nf = COALESCE($9, valor_nf), data_atualizacao = CURRENT_TIMESTAMP WHERE thread_id = $10`, valoresBD);
                    } else {
                        await pool.query(`INSERT INTO leads_cotacoes (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [args.cnpj ?? null, args.empresa ?? 'Não informada', args.rota_origem ?? 'A definir', args.rota_destino ?? 'A definir', args.nome_contato ?? 'Em atendimento...', args.telefone ?? 'Aguardando...', args.peso_carga ?? null, args.volume_carga ?? null, args.valor_nf ?? null, threadId]);
                    }

                    if (args.cotacao_finalizada) {
                        cotacaoFinalizada = true; 
                        const resLead = await pool.query('SELECT * FROM leads_cotacoes WHERE thread_id = $1', [threadId]);
                        if (resLead.rows.length > 0) {
                            const lead = resLead.rows[0];
                            const demandaChat = `[ATENDIMENTO IA] Rota: ${lead.rota_origem} -> ${lead.rota_destino} | Peso/Vol: ${lead.peso_carga} ${lead.volume_carga}`.trim();
                            await enviarAlertaWhatsApp(lead.nome_contato, lead.empresa, lead.telefone, demandaChat);
                        }
                    }
                }
                const functionResponseResult = await chat.sendMessage([{ functionResponse: { name: "salvar_dados_crm", response: { sucesso: podeSalvar, instrucao: mensagemParaIA } } }]);
                aiResponseText = functionResponseResult.response.text();
            }
        }
        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory, threadId: threadId, finalizada: cotacaoFinalizada }); 
    } catch (erro) {
        console.error("🚨 Erro Chat:", erro);
        res.status(500).json({ reply: "Desculpe, falha de conexão. Podemos retomar?", history, threadId, finalizada: false });
    }
});

app.post('/api/formulario', async (req, res) => {
    const { nome, email, telefone, cnpj, necessidade, mensagem } = req.body;
    try {
        if (!isEmailCorporativo(email)) return res.status(400).json({ success: false, message: 'Utilize e-mail corporativo.' });
        if (!validarTelefoneBR(telefone)) return res.status(400).json({ success: false, message: 'Telefone inválido.' });
        const validacao = await consultarCNPJ(cnpj ? String(cnpj).replace(/\D/g, '') : '');
        if (!validacao.valido) return res.status(400).json({ success: false, message: validacao.erro || 'CNPJ não encontrado.' });

        await pool.query(`INSERT INTO leads_cotacoes (nome_contato, empresa, cnpj, telefone, email, tipo_mercadoria, particularidades, canal_origem, status, thread_id, rota_origem, rota_destino) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [nome, validacao.razao_social, formatarCNPJ(cnpj), formatarTelefone(telefone), email, necessidade, `Mensagem: ${mensagem}`, 'Formulario Site', 'Novo Lead', `form_${Date.now()}`, 'A definir', 'A definir']);
        await enviarAlertaWhatsApp(nome, validacao.razao_social, telefone, necessidade);
        res.status(200).json({ success: true, message: 'Formulário enviado!' });
    } catch (erro) { res.status(500).json({ success: false, message: 'Erro interno.' }); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const senhasUsuarios = {
        'comercial@bmroadtransportes.com.br': process.env.PASS_COMERCIAL,
        'operacional@bmroadtransportes.com.br': process.env.PASS_OPERACIONAL,
        'vendas1@bmroadtransportes.com.br': process.env.PASS_VENDAS1
    };
    if (senhasUsuarios[email] && senhasUsuarios[email] === password) res.json({ success: true, token: 'bmroad_auth_token_secure_xyz' });
    else res.status(401).json({ success: false, message: 'Credenciais incorretas.' });
});

// =================================================================
// ⚡ MOTOR DE ALTA PERFORMANCE (PAGINAÇÃO, BUSCA GLOBAL, ORDENAÇÃO)
// =================================================================

app.get('/api/empresas', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20; 
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || ''; 
    const sortBy = req.query.sortBy || 'id'; 
    const order = req.query.order === 'ASC' ? 'ASC' : 'DESC';

    try {
        let conditions = '1=1';
        let params = [];
        let paramIndex = 1;

        if (search) {
            conditions += ` AND (razao_social ILIKE $${paramIndex} OR cnpj ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        if (status) {
            conditions += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        const dataQuery = `
            SELECT e.*, 
                   (SELECT status_comercial FROM oportunidades o WHERE o.empresa_id = e.id ORDER BY id DESC LIMIT 1) as status_comercial
            FROM empresas e 
            WHERE ${conditions} 
            ORDER BY ${sortBy} ${order} 
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        const dataParams = [...params, limit, offset];
        const result = await pool.query(dataQuery, dataParams);

        const countQuery = `SELECT COUNT(*) FROM empresas WHERE ${conditions}`;
        const countResult = await pool.query(countQuery, params);

        res.json({
            data: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: page,
            limit: limit
        });
    } catch (e) { 
        console.error("Erro Paginação Empresas:", e);
        res.status(500).json({ error: 'Erro no banco.' }); 
    }
});

app.get('/api/contatos', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20; 
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    const search = req.query.search || '';

    try {
        let conditions = '1=1';
        let params = [];
        if (search) {
            conditions += ` AND (c.nome ILIKE $1 OR c.email ILIKE $1 OR c.telefone ILIKE $1 OR e.razao_social ILIKE $1)`;
            params.push(`%${search}%`);
        }

        const query = `
            SELECT c.*, e.razao_social as empresa_nome 
            FROM contatos c 
            LEFT JOIN empresas e ON c.empresa_id = e.id 
            WHERE ${conditions} ORDER BY c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const result = await pool.query(query, [...params, limit, offset]);
        const countResult = await pool.query(`SELECT COUNT(*) FROM contatos c LEFT JOIN empresas e ON c.empresa_id = e.id WHERE ${conditions}`, params);

        res.json({ data: result.rows, total: parseInt(countResult.rows[0].count) });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.get('/api/leads', async (req, res) => {
    if (req.headers.authorization !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    const limit = parseInt(req.query.limit) || 20; 
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    try {
        const result = await pool.query('SELECT * FROM leads_cotacoes ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
        const countResult = await pool.query('SELECT COUNT(*) FROM leads_cotacoes');
        res.json({ data: result.rows, total: parseInt(countResult.rows[0].count) });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

// =================================================================
// 🗑️ ROTAS DE EXCLUSÃO SEGURA (DELETE)
// =================================================================
app.delete('/api/empresas/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM empresas WHERE id = $1 RETURNING *', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada' });
        res.json({ success: true, message: 'Empresa e dados vinculados excluídos.' });
    } catch (error) { res.status(500).json({ error: 'Erro interno ao excluir.' }); }
});

app.delete('/api/contatos/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM contatos WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Erro ao excluir contato.' }); }
});

app.delete('/api/oportunidades/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM oportunidades WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Erro ao excluir oportunidade.' }); }
});

// =================================================================
// ⬇️ ROTA DE EXPORTAÇÃO (CSV)
// =================================================================
app.get('/api/exportar/empresas', async (req, res) => {
    try {
        const result = await pool.query('SELECT razao_social, cnpj, cidade, uf, faturamento, classe_abc, status FROM empresas ORDER BY razao_social ASC');
        if (result.rows.length === 0) return res.status(404).send("Nenhum dado encontrado");

        const colunas = Object.keys(result.rows[0]);
        let csvString = colunas.join(';') + '\n';
        
        result.rows.forEach(row => {
            const linha = colunas.map(col => `"${row[col] ? String(row[col]).replace(/"/g, '""') : ''}"`).join(';');
            csvString += linha + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="BM_Road_Clientes.csv"');
        res.send('\uFEFF' + csvString); 
    } catch (error) {
        res.status(500).send("Erro ao gerar arquivo");
    }
});

// =================================================================
// 📊 ROTAS DO FUNIL DE VENDAS (KANBAN)
// =================================================================
app.get('/api/oportunidades/kanban', async (req, res) => {
    try {
        // Agora buscamos a empresa, o contato específico e ocultamos Ganhas/Perdidas
        const query = `
            SELECT o.*, e.razao_social, e.cnpj, c.nome as nome_contato, f.nome as nome_etapa 
            FROM oportunidades o
            LEFT JOIN empresas e ON o.empresa_id = e.id
            LEFT JOIN contatos c ON o.contato_id = c.id
            LEFT JOIN funil_etapas f ON o.etapa_id = f.id
            WHERE o.status_comercial NOT IN ('Ganha', 'Perdida', 'Fechado / Ganho')
            ORDER BY o.data_atualizacao DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar kanban:', error);
        res.status(500).json({ error: 'Erro ao buscar oportunidades do Kanban.' });
    }
});

// Busca os dados ultra-ricos para o Card SPRINT da Oportunidade
app.get('/api/oportunidades/:id/detalhes', async (req, res) => {
    try {
        const query = `
            SELECT o.*, e.razao_social, e.cnpj, c.nome as nome_contato, c.telefone as telefone_contato, f.nome as nome_etapa 
            FROM oportunidades o
            LEFT JOIN empresas e ON o.empresa_id = e.id
            LEFT JOIN contatos c ON o.contato_id = c.id
            LEFT JOIN funil_etapas f ON o.etapa_id = f.id
            WHERE o.id = $1
        `;
        const result = await pool.query(query, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Oportunidade não encontrada' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao buscar detalhes da oportunidade:', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

app.get('/api/funil_etapas', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM funil_etapas ORDER BY ordem ASC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.post('/api/funil_etapas', async (req, res) => {
    const { nome, cor, ordem } = req.body;
    try {
        const result = await pool.query('INSERT INTO funil_etapas (nome, cor, ordem) VALUES ($1, $2, $3) RETURNING *', [nome, cor, ordem]);
        res.json({ success: true, etapa: result.rows[0] });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.post('/api/leads/:id/efetivar', async (req, res) => {
    const leadId = req.params.id;
    const { tipo_oportunidade, etapa_id, status_comercial } = req.body; 
    
    const servico = ['Carga Fracionada', 'Armazenagem Hub SP', 'Carga Dedicada', 'Outros'].includes(tipo_oportunidade) ? tipo_oportunidade : 'Outros';
    const statusReal = status_comercial || 'Em Cotação';

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const resLead = await client.query('SELECT * FROM leads_cotacoes WHERE id = $1', [leadId]);
        if (resLead.rows.length === 0) throw new Error('Lead não encontrado.');
        const lead = resLead.rows[0];
        const cnpjIdentificador = lead.cnpj ? String(lead.cnpj).replace(/\D/g, '') : (lead.empresa ? String(lead.empresa).trim().toLowerCase() : `emp_${Date.now()}`);

        let empId, contId;
        const resEmp = await client.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjIdentificador]);
        if (resEmp.rows.length > 0) empId = resEmp.rows[0].id;
        else { 
            const r = await client.query(`INSERT INTO empresas (razao_social, cnpj) VALUES ($1, $2) RETURNING id`, [lead.empresa || 'Empresa Em Processamento', cnpjIdentificador]); 
            empId = r.rows[0].id; 
        }

        const resCont = await client.query('SELECT id FROM contatos WHERE empresa_id = $1 AND (telefone = $2 OR email = $3)', [empId, lead.telefone, lead.email]);
        if (resCont.rows.length > 0) contId = resCont.rows[0].id;
        else await client.query(`INSERT INTO contatos (empresa_id, nome, telefone, email) VALUES ($1, $2, $3, $4)`, [empId, lead.nome_contato || 'Desconhecido', lead.telefone, lead.email]);

        await client.query(
            `INSERT INTO oportunidades (empresa_id, tipo_oportunidade, status_comercial, rota_origem, rota_destino, peso_carga, volume_carga, valor_nf, etapa_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, 
            [empId, servico, statusReal, lead.rota_origem, lead.rota_destino, lead.peso_carga, lead.volume_carga, lead.valor_nf, etapa_id || null]
        );
        
        await client.query('UPDATE leads_cotacoes SET status = $1 WHERE id = $2', ['Efetivado / Qualificado', leadId]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Empresa efetivada e enviada para o Funil!' });
    } catch (error) { 
        await client.query('ROLLBACK'); 
        console.error("Erro Efetivar:", error);
        res.status(500).json({ success: false, message: 'Erro ao migrar lead.' }); 
    } finally { 
        client.release(); 
    }
});

// ==========================================
// MÉTODOS GERAIS (ATUALIZAÇÕES)
// ==========================================
app.get('/api/empresas/:id/360', async (req, res) => {
    try {
        const emp = await pool.query('SELECT * FROM empresas WHERE id = $1', [req.params.id]);
        if (emp.rows.length === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
        const ctts = await pool.query('SELECT * FROM contatos WHERE empresa_id = $1', [req.params.id]);
        const opps = await pool.query('SELECT * FROM oportunidades WHERE empresa_id = $1 ORDER BY id DESC', [req.params.id]);
        res.json({ empresa: emp.rows[0], contatos: ctts.rows, oportunidades: opps.rows });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/oportunidades/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE oportunidades SET status_comercial = COALESCE($1, status_comercial), etapa_id = COALESCE($2, etapa_id) WHERE id = $3', [req.body.status_comercial, req.body.etapa_id, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/oportunidades/:id/dados', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(`UPDATE oportunidades SET rota_origem = COALESCE($1, rota_origem), rota_destino = COALESCE($2, rota_destino), peso_carga = COALESCE($3, peso_carga), volume_carga = COALESCE($4, volume_carga), valor_nf = COALESCE($5, valor_nf), valor_frete = COALESCE($6, valor_frete), tabela_preco = COALESCE($7, tabela_preco) WHERE id = $8`, [b.rota_origem, b.rota_destino, b.peso_carga, b.volume_carga, b.valor_nf || null, b.valor_frete || null, b.tabela_preco, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/empresas/:id', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `UPDATE empresas SET 
                razao_social = COALESCE($1, razao_social), 
                cnpj = COALESCE($2, cnpj), 
                segmento = COALESCE($3, segmento), 
                porte = COALESCE($4, porte), 
                endereco = COALESCE($5, endereco), 
                site = COALESCE($6, site) 
            WHERE id = $7`,
            [b.razao_social, b.cnpj, b.segmento, b.porte, b.endereco, b.site, req.params.id]
        );
        res.json({ success: true });
    } catch (e) { 
        console.error("Erro ao atualizar empresa:", e);
        res.status(500).json({ error: 'Erro banco.' }); 
    }
});

app.put('/api/contatos/:id', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `UPDATE contatos SET nome = COALESCE($1, nome), cargo = COALESCE($2, cargo), telefone = COALESCE($3, telefone), email = COALESCE($4, email) WHERE id = $5`, 
            [b.nome, b.cargo, b.telefone, b.email, req.params.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.get('/', (req, res) => res.send('🚀 Motor IA BM Road : Blindado e Operacional!'));

// =================================================================
// ROTAS ÚNICAS E OTIMIZADAS PARA CRIAÇÃO (BOTÃO + E FICHA 360°)
// =================================================================

app.post('/api/empresas', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `INSERT INTO empresas (razao_social, cnpj, status) VALUES ($1, $2, $3)`,
            [b.razao_social, b.cnpj, b.status || 'Ativo']
        );
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao criar empresa:", e);
        res.status(500).json({ error: 'Erro ao criar empresa.' });
    }
});

app.post('/api/contatos', async (req, res) => {
    const b = req.body;
    try {
        // Tenta inserir com o cargo, se a coluna não existir, o catch trata
        try {
            await pool.query(
                `INSERT INTO contatos (empresa_id, nome, telefone, email, cargo) VALUES ($1, $2, $3, $4, $5)`,
                [b.empresa_id, b.nome, b.telefone, b.email, b.cargo || '']
            );
        } catch (dbErr) {
            await pool.query(
                `INSERT INTO contatos (empresa_id, nome, telefone, email) VALUES ($1, $2, $3, $4)`,
                [b.empresa_id, b.nome, b.telefone, b.email]
            );
        }
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao criar contato:", e);
        res.status(500).json({ error: 'Erro ao criar contato.' });
    }
});

app.post('/api/oportunidades', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `INSERT INTO oportunidades (empresa_id, contato_id, etapa_id, tipo_oportunidade, status_comercial, rota_origem, rota_destino, peso_carga, volume_carga, valor_nf, valor_frete, tabela_preco) 
             VALUES ($1, $2, $3, $4, 'Em Cotação', $5, $6, $7, $8, $9, $10, $11)`,
            [b.empresa_id, b.contato_id || null, b.etapa_id || null, b.tipo_oportunidade, b.rota_origem, b.rota_destino, b.peso_carga, b.volume_carga, b.valor_nf || null, b.valor_frete || null, b.tabela_preco || 'Avulso']
        );
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao criar oportunidade:", e);
        res.status(500).json({ error: 'Erro ao criar oportunidade.' });
    }
});

// =================================================================
// 🎯 ROTAS DE FECHAMENTO E TAREFAS (CRM KANBAN V2)
// =================================================================

// 1. Fechamento de Oportunidade (Ganha/Perdida)
app.put('/api/oportunidades/:id/checkout', async (req, res) => {
    const { status_comercial, motivo_perda, observacao_fechamento, valor_frete, valor_nf, peso_carga, volume_carga } = req.body;
    try {
        await pool.query(
            `UPDATE oportunidades SET
                status_comercial = $1,
                motivo_perda = $2,
                observacao_fechamento = $3,
                valor_frete = COALESCE($4, valor_frete),
                valor_nf = COALESCE($5, valor_nf),
                peso_carga = COALESCE($6, peso_carga),
                volume_carga = COALESCE($7, volume_carga),
                data_fechamento = CURRENT_TIMESTAMP
             WHERE id = $8`,
            [status_comercial, motivo_perda, observacao_fechamento, valor_frete, valor_nf, peso_carga, volume_carga, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        console.error("Erro no checkout:", e);
        res.status(500).json({ error: 'Erro ao processar fechamento.' });
    }
});

// 2. Buscar Tarefas de uma Oportunidade
app.get('/api/oportunidades/:id/tarefas', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tarefas_crm WHERE oportunidade_id = $1 ORDER BY data_limite ASC', [req.params.id]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Erro ao buscar tarefas.' }); }
});

// 3. Criar Nova Tarefa
app.post('/api/oportunidades/:id/tarefas', async (req, res) => {
    const { tipo, descricao, data_limite } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO tarefas_crm (oportunidade_id, tipo, descricao, data_limite, status)
             VALUES ($1, $2, $3, $4, 'Pendente') RETURNING *`,
            [req.params.id, tipo, descricao, data_limite]
        );
        res.json({ success: true, tarefa: result.rows[0] });
    } catch (e) { res.status(500).json({ error: 'Erro ao criar tarefa.' }); }
});

// 4. Alterar Status da Tarefa
app.put('/api/tarefas/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE tarefas_crm SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro ao atualizar tarefa.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor IA BM Road : Servidor rodando na porta ${PORT}!`));
