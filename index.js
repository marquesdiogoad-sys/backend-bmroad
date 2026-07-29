import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from './db.js';
import { isaSystemInstruction } from './isaPrompt.js';

dotenv.config();
const app = express();

// --- CONFIGURAÇÃO DE CORS SIMPLIFICADA PARA DESENVOLVIMENTO ---
app.use(cors());
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
    if (n.length === 11) {
        return `(${n.substring(0, 2)}) ${n.substring(2, 7)}-${n.substring(7, 11)}`; 
    } else if (n.length === 10) {
        return `(${n.substring(0, 2)}) ${n.substring(2, 6)}-${n.substring(6, 10)}`; 
    }
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
    const todosIguais = /^(\d)\1+$/.test(numeroSemDDD);
    if (todosIguais) return false;
    if (numeroSemDDD === '123456789' || numeroSemDDD === '12345678') return false;
    return true;
}

async function consultarCNPJ(cnpjOriginal) {
    if (!cnpjOriginal) return { valido: false, erro: "CNPJ é obrigatório." };
    const cnpjNumeros = String(cnpjOriginal).replace(/\D/g, '');
    if (cnpjNumeros.length !== 14) return { valido: false, erro: "O CNPJ precisa ter exatamente 14 números." };

    try {
        const res1 = await fetch(`https://publica.cnpj.ws/cnpj/${cnpjNumeros}`);
        if (res1.ok) {
            const data1 = await res1.json();
            return { valido: true, razao_social: data1.razao_social };
        }
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
        if (res3.ok) {
            const data3 = await res3.json();
            return { valido: true, razao_social: data3.razao_social };
        }
    } catch (e) {}

    return { valido: false, erro: "Instabilidade na verificação com a Receita." };
}

async function enviarAlertaWhatsApp(nome, empresa, telefone, necessidade) {
    const numero = "5511954937948";
    const apiKey = "8836652";
    
    const textoBruto = `🚨 *NOVO LEAD BM ROAD!*\n\n*Empresa:* ${empresa}\n*Contato:* ${nome}\n*Telefone:* ${telefone}\n*Demanda:* ${necessidade}\n\n🔥 _Acesse o CRM para ver os detalhes!_`;
    const textoCodificado = encodeURIComponent(textoBruto);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${numero}&text=${textoCodificado}&apikey=${apiKey}`;

    try {
        const response = await fetch(url);
        if (response.ok) console.log("✅ WhatsApp disparado!");
    } catch (error) {
        console.error("🚨 Erro WhatsApp:", error);
    }
}

// --- ROTA PRINCIPAL DO CHAT ---
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];
    const threadId = req.body.threadId || `sessao_${Date.now()}`;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: ferramentas,
            systemInstruction: isaSystemInstruction,
        });

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

                if (args.telefone && !validarTelefoneBR(args.telefone)) {
                    podeSalvar = false;
                    mensagemParaIA = "ERRO DE VALIDAÇÃO: Telefone inválido.";
                }

                if (podeSalvar && args.cnpj) {
                    const validacaoCnpj = await consultarCNPJ(args.cnpj);
                    if (!validacaoCnpj.valido) {
                        podeSalvar = false;
                        mensagemParaIA = `ERRO DE VALIDAÇÃO: ${validacaoCnpj.erro}`;
                    } else if (validacaoCnpj.razao_social) {
                        args.empresa = validacaoCnpj.razao_social;
                    }
                }

                if (podeSalvar) {
                    const cnpjPadrao = formatarCNPJ(args.cnpj);
                    const telefonePadrao = formatarTelefone(args.telefone);

                    const valoresBD = [
                        cnpjPadrao ?? null,
                        args.empresa ?? null,
                        args.rota_origem ?? null,
                        args.rota_destino ?? null,
                        args.nome_contato ?? null,
                        telefonePadrao ?? null,
                        args.peso_carga ?? null,
                        args.volume_carga ?? null,
                        args.valor_nf ?? null,
                        threadId
                    ];

                    const resVerifica = await pool.query('SELECT id FROM leads_cotacoes WHERE thread_id = $1', [threadId]);

                    if (resVerifica.rows.length > 0) {
                        await pool.query(`
                            UPDATE leads_cotacoes SET
                                cnpj = COALESCE($1, cnpj), empresa = COALESCE($2, empresa), rota_origem = COALESCE($3, rota_origem),
                                rota_destino = COALESCE($4, rota_destino), nome_contato = COALESCE($5, nome_contato),
                                telefone = COALESCE($6, telefone), peso_carga = COALESCE($7, peso_carga),
                                volume_carga = COALESCE($8, volume_carga), valor_nf = COALESCE($9, valor_nf), data_atualizacao = CURRENT_TIMESTAMP
                            WHERE thread_id = $10
                        `, valoresBD);
                    } else {
                        await pool.query(`
                            INSERT INTO leads_cotacoes
                            (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        `, [args.cnpj ?? null, args.empresa ?? 'Não informada', args.rota_origem ?? 'A definir', args.rota_destino ?? 'A definir', args.nome_contato ?? 'Em atendimento...', args.telefone ?? 'Aguardando...', args.peso_carga ?? null, args.volume_carga ?? null, args.valor_nf ?? null, threadId]);
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

function isEmailCorporativo(email) {
    const provedoresGratuitos = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br', 'bol.com.br', 'uol.com.br', 'ig.com.br', 'icloud.com', 'msn.com'];
    const dominio = email.split('@')[1];
    if (!dominio) return false;
    return !provedoresGratuitos.includes(dominio.toLowerCase());
}

app.post('/api/formulario', async (req, res) => {
    const { nome, email, telefone, cnpj, necessidade, mensagem } = req.body;
    const threadId = `form_${Date.now()}`;

    try {
        if (!isEmailCorporativo(email)) return res.status(400).json({ success: false, message: 'Utilize e-mail corporativo.' });
        if (!validarTelefoneBR(telefone)) return res.status(400).json({ success: false, message: 'Telefone inválido.' });

        const validacao = await consultarCNPJ(cnpj ? String(cnpj).replace(/\D/g, '') : '');
        if (!validacao.valido) return res.status(400).json({ success: false, message: validacao.erro || 'CNPJ não encontrado.' });

        await pool.query(`
            INSERT INTO leads_cotacoes (nome_contato, empresa, cnpj, telefone, email, tipo_mercadoria, particularidades, canal_origem, status, thread_id, rota_origem, rota_destino)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [nome, validacao.razao_social, formatarCNPJ(cnpj), formatarTelefone(telefone), email, necessidade, `Mensagem: ${mensagem}`, 'Formulario Site', 'Novo Lead', threadId, 'A definir', 'A definir']);

        await enviarAlertaWhatsApp(nome, validacao.razao_social, telefone, necessidade);
        res.status(200).json({ success: true, message: 'Formulário enviado!' });

    } catch (erro) {
        console.error("🚨 Erro Formulário:", erro);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const senhasUsuarios = {
        'comercial@bmroadtransportes.com.br': process.env.PASS_COMERCIAL,
        'operacional@bmroadtransportes.com.br': process.env.PASS_OPERACIONAL,
        'vendas1@bmroadtransportes.com.br': process.env.PASS_VENDAS1
    };

    if (senhasUsuarios[email] && senhasUsuarios[email] === password) {
        res.json({ success: true, token: 'bmroad_auth_token_secure_xyz' });
    } else {
        res.status(401).json({ success: false, message: 'Credenciais incorretas.' });
    }
});

app.get('/api/leads', async (req, res) => {
    if (req.headers.authorization !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    try {
        // Ordena por 'id DESC' para garantir compatibilidade total com a tabela local
        const result = await pool.query('SELECT * FROM leads_cotacoes ORDER BY id DESC');
        res.json(result.rows);
    } catch (erro) { 
        console.error("🚨 Erro real na consulta /api/leads:", erro);
        res.status(500).json({ error: 'Erro no banco de dados.' }); 
    }
});

app.get('/', (req, res) => res.send('🚀 Motor IA BM Road : Blindado e Operacional!'));

// =================================================================
// ENDPOINT DE GESTÃO LOGÍSTICA: EFETIVAR LEAD COMO CONTA PERMANENTE
// =================================================================
app.post('/api/leads/:id/efetivar', async (req, res) => {
    const leadId = req.params.id;
    const { tipo_oportunidade } = req.body;
    const servicoDefinido = ['Carga Fracionada', 'Armazenagem Hub SP', 'Carga Dedicada', 'Outros'].includes(tipo_oportunidade) ? tipo_oportunidade : 'Outros';

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Busca os dados brutos do lead
        const resLead = await client.query('SELECT * FROM leads_cotacoes WHERE id = $1', [leadId]);
        if (resLead.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Lead não encontrado.' });
        }
        const lead = resLead.rows[0];
        const cnpjIdentificador = lead.cnpj ? String(lead.cnpj).replace(/\D/g, '') : (lead.empresa ? String(lead.empresa).trim().toLowerCase() : `emp_${Date.now()}`);

        let empresaId;
        let contatoId;

        // 2. Cria ou Recupera Empresa
        const resEmpresa = await client.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjIdentificador]);
        if (resEmpresa.rows.length > 0) {
            empresaId = resEmpresa.rows[0].id;
        } else {
            const qNovaEmp = `INSERT INTO empresas (razao_social, cnpj) VALUES ($1, $2) RETURNING id`;
            const rNovaEmp = await client.query(qNovaEmp, [lead.empresa || 'Empresa Em Processamento', cnpjIdentificador]);
            empresaId = rNovaEmp.rows[0].id;
        }

        // 3. Cria ou Recupera Contato
        const resContato = await client.query('SELECT id FROM contatos WHERE empresa_id = $1 AND (telefone = $2 OR email = $3)', [empresaId, lead.telefone, lead.email]);
        if (resContato.rows.length > 0) {
            contatoId = resContato.rows[0].id;
        } else {
            const qNovoCont = `INSERT INTO contatos (empresa_id, nome, telefone, email) VALUES ($1, $2, $3, $4) RETURNING id`;
            const rNovoCont = await client.query(qNovoCont, [empresaId, lead.nome_contato || 'Contato Desconhecido', lead.telefone, lead.email]);
            contatoId = rNovoCont.rows[0].id;
        }

        // 4. Cria Oportunidade
        try {
            await client.query(
                `INSERT INTO oportunidades (empresa_id, tipo_oportunidade, status_comercial, rota_origem, rota_destino, peso_carga, volume_carga, valor_nf) 
                 VALUES ($1, $2, 'Em Cotação', $3, $4, $5, $6, $7)`,
                [empresaId, servicoDefinido, lead.rota_origem, lead.rota_destino, lead.peso_carga, lead.volume_carga, lead.valor_nf]
            );
        } catch (dbErr) {
            console.warn("⚠️ Fallback ativado na Oportunidade (Tabela pode diferir). Salvando com campos mínimos.");
            await client.query(`INSERT INTO oportunidades (empresa_id, tipo_oportunidade) VALUES ($1, $2)`, [empresaId, servicoDefinido]);
        }

        // 5. Atualiza o Lead para Efetivado
        await client.query('UPDATE leads_cotacoes SET status = $1 WHERE id = $2', ['Efetivado / Qualificado', leadId]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Empresa efetivada com sucesso!', empresa_id: empresaId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('🚨 Erro ao Efetivar Lead:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao migrar lead.' });
    } finally {
        client.release();
    }
});

// ==========================================
// OUTRAS ROTAS DO CRM 
// ==========================================
app.get('/api/empresas/:id/360', async (req, res) => {
    try {
        const emp = await pool.query('SELECT * FROM empresas WHERE id = $1', [req.params.id]);
        if (emp.rows.length === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
        const ctts = await pool.query('SELECT * FROM contatos WHERE empresa_id = $1 LIMIT 3', [req.params.id]);
        const opps = await pool.query('SELECT * FROM oportunidades WHERE empresa_id = $1 ORDER BY id DESC', [req.params.id]);
        res.json({ empresa: emp.rows[0], contatos: ctts.rows, oportunidades: opps.rows });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.get('/api/empresas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT e.*, 
                   (SELECT status_comercial FROM oportunidades o WHERE o.empresa_id = e.id ORDER BY id DESC LIMIT 1) as status_comercial,
                   (SELECT rota_origem FROM oportunidades o WHERE o.empresa_id = e.id ORDER BY id DESC LIMIT 1) as rota_origem,
                   (SELECT rota_destino FROM oportunidades o WHERE o.empresa_id = e.id ORDER BY id DESC LIMIT 1) as rota_destino
            FROM empresas e ORDER BY e.id DESC
        `);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.get('/api/contatos', async (req, res) => {
    try {
        const result = await pool.query('SELECT c.*, e.razao_social as empresa_nome FROM contatos c LEFT JOIN empresas e ON c.empresa_id = e.id ORDER BY c.nome ASC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/oportunidades/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE oportunidades SET status_comercial = $1 WHERE id = $2', [req.body.status_comercial, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/oportunidades/:id/dados', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `UPDATE oportunidades SET rota_origem = COALESCE($1, rota_origem), rota_destino = COALESCE($2, rota_destino), peso_carga = COALESCE($3, peso_carga), volume_carga = COALESCE($4, volume_carga), valor_nf = COALESCE($5, valor_nf), valor_frete = COALESCE($6, valor_frete), tabela_preco = COALESCE($7, tabela_preco) WHERE id = $8`,
            [b.rota_origem, b.rota_destino, b.peso_carga, b.volume_carga, b.valor_nf || null, b.valor_frete || null, b.tabela_preco, req.params.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/empresas/:id', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(
            `UPDATE empresas SET razao_social = COALESCE($1, razao_social), cnpj = COALESCE($2, cnpj), segmento = COALESCE($3, segmento), porte = COALESCE($4, porte), endereco = COALESCE($5, endereco), site = COALESCE($6, site) WHERE id = $7`,
            [b.razao_social, b.cnpj, b.segmento, b.porte, b.endereco, b.site, req.params.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

app.put('/api/contatos/:id', async (req, res) => {
    const b = req.body;
    try {
        await pool.query(`UPDATE contatos SET nome = COALESCE($1, nome), telefone = COALESCE($2, telefone), email = COALESCE($3, email) WHERE id = $4`, [b.nome, b.telefone, b.email, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro banco.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor IA BM Road : Servidor rodando na porta ${PORT}!`));