import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from './db.js';
import { isaSystemInstruction } from './isaPrompt.js';

dotenv.config();
const app = express();
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

// --- FUNÇÕES DE VALIDAÇÃO (SEGURANÇA) ---
function validarTelefoneBR(telefone) {
    if (!telefone) return true;
    const numeros = telefone.replace(/\D/g, '');
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
    const cnpjNumeros = cnpjOriginal.replace(/\D/g, '');
    if (cnpjNumeros.length !== 14) return { valido: false, erro: "O CNPJ precisa ter exatamente 14 números." };

    try {
        const res1 = await fetch(`https://publica.cnpj.ws/cnpj/${cnpjNumeros}`);
        if (res1.ok) {
            const data1 = await res1.json();
            return { valido: true, razao_social: data1.razao_social };
        }
        if (res1.status === 404 || res1.status === 400) return { valido: false, erro: "CNPJ não existe na base da Receita." };
    } catch (e) { console.log("Tentativa 1 falhou."); }

    try {
        const res2 = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpjNumeros}`);
        if (res2.ok) {
            const data2 = await res2.json();
            if (data2.status === "ERROR") return { valido: false, erro: "CNPJ rejeitado pela Receita." };
            return { valido: true, razao_social: data2.nome };
        }
    } catch (e) { console.log("Tentativa 2 falhou."); }

    try {
        const res3 = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNumeros}`);
        if (res3.ok) {
            const data3 = await res3.json();
            return { valido: true, razao_social: data3.razao_social };
        }
        if (res3.status === 404 || res3.status === 400) return { valido: false, erro: "CNPJ inválido ou não encontrado." };
    } catch (e) { console.log("Tentativa 3 falhou."); }

    return { valido: false, erro: "Instabilidade na verificação com a Receita. Confirme o CNPJ ou tente em instantes." };
}

// --- FUNÇÃO DE DISPARO WHATSAPP (ISOLADA E BLINDADA) ---
async function enviarAlertaWhatsApp(nome, empresa, telefone, necessidade) {
    const numero = "5511954937948";
    const apiKey = "8836652";
    
    const textoBruto = `🚨 *NOVO LEAD BM ROAD!*\n\n*Empresa:* ${empresa}\n*Contato:* ${nome}\n*Telefone:* ${telefone}\n*Demanda:* ${necessidade}\n\n🔥 _Acesse o CRM para ver os detalhes!_`;
    const textoCodificado = encodeURIComponent(textoBruto);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${numero}&text=${textoCodificado}&apikey=${apiKey}`;

    try {
        const response = await fetch(url);
        if (response.ok) {
            console.log("✅ Alerta de WhatsApp disparado com sucesso!");
        } else {
            console.error("⚠️ Falha ao disparar WhatsApp. Status:", response.status);
        }
    } catch (error) {
        console.error("🚨 Erro na requisição do WhatsApp:", error);
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
                    mensagemParaIA = "ERRO DE VALIDAÇÃO: Diga ao cliente que o telefone parece inválido e peça para ele digitar com DDD corretamente.";
                }

                if (podeSalvar && args.cnpj) {
                    const validacaoCnpj = await consultarCNPJ(args.cnpj);
                    if (!validacaoCnpj.valido) {
                        podeSalvar = false;
                        mensagemParaIA = `ERRO DE VALIDAÇÃO: ${validacaoCnpj.erro} Peça ao cliente para verificar o número digitado.`;
                    } else if (validacaoCnpj.razao_social) {
                        args.empresa = validacaoCnpj.razao_social;
                    }
                }

                if (podeSalvar) {
                    const valoresBD = [
                        args.cnpj ?? null,
                        args.empresa ?? null,
                        args.rota_origem ?? null,
                        args.rota_destino ?? null,
                        args.nome_contato ?? null,
                        args.telefone ?? null,
                        args.peso_carga ?? null,
                        args.volume_carga ?? null,
                        args.valor_nf ?? null,
                        threadId
                    ];

                    const queryVerifica = 'SELECT id FROM leads_cotacoes WHERE thread_id = $1';
                    const resVerifica = await pool.query(queryVerifica, [threadId]);

                    if (resVerifica.rows.length > 0) {
                        await pool.query(`
                            UPDATE leads_cotacoes
                            SET
                                cnpj = COALESCE($1, cnpj),
                                empresa = COALESCE($2, empresa),
                                rota_origem = COALESCE($3, rota_origem),
                                rota_destino = COALESCE($4, rota_destino),
                                nome_contato = COALESCE($5, nome_contato),
                                telefone = COALESCE($6, telefone),
                                peso_carga = COALESCE($7, peso_carga),
                                volume_carga = COALESCE($8, volume_carga),
                                valor_nf = COALESCE($9, valor_nf),
                                data_atualizacao = CURRENT_TIMESTAMP
                            WHERE thread_id = $10
                        `, valoresBD);
                    } else {
                        await pool.query(`
                            INSERT INTO leads_cotacoes
                            (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        `, [
                            args.cnpj ?? null,
                            args.empresa ?? 'Não informada',
                            args.rota_origem ?? 'A definir',
                            args.rota_destino ?? 'A definir',
                            args.nome_contato ?? 'Em atendimento...',
                            args.telefone ?? 'Aguardando...',
                            args.peso_carga ?? null,
                            args.volume_carga ?? null,
                            args.valor_nf ?? null,
                            threadId
                        ]);
                    }

                    if (args.cotacao_finalizada) {
                        const resLeadCompleto = await pool.query('SELECT * FROM leads_cotacoes WHERE thread_id = $1', [threadId]);
                        
                        if (resLeadCompleto.rows.length > 0) {
                            const lead = resLeadCompleto.rows[0];
                            
                            const origem = lead.rota_origem || "Não informada";
                            const destino = lead.rota_destino || "Não informada";
                            const mercadoria = `Peso/Vol: ${lead.peso_carga || ''} ${lead.volume_carga || ''}`.trim();
                            const demandaChat = `[ATENDIMENTO IA] Rota: ${origem} -> ${destino} | ${mercadoria}`;

                            await enviarAlertaWhatsApp(
                                lead.nome_contato || "Não informado", 
                                lead.empresa || "Não informada", 
                                lead.telefone || "Não informado", 
                                demandaChat
                            );
                        }
                    }
                }

                const functionResponseResult = await chat.sendMessage([{
                    functionResponse: {
                        name: "salvar_dados_crm",
                        response: { sucesso: podeSalvar, instrucao: mensagemParaIA }
                    }
                }]);
                aiResponseText = functionResponseResult.response.text();
            }
        }

        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory, threadId: threadId });

    } catch (erro) {
        console.error("🚨 Erro na API do Chat:", erro);
        res.status(500).json({ reply: "Peço imensa desculpa, estou a ter uma pequena falha de conexão. Podemos retomar?", history, threadId });
    }
});

function isEmailCorporativo(email) {
    const provedoresGratuitos = [
        'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com',
        'yahoo.com.br', 'bol.com.br', 'uol.com.br', 'ig.com.br',
        'icloud.com', 'msn.com'
    ];
    const dominio = email.split('@')[1];
    if (!dominio) return false;
    return !provedoresGratuitos.includes(dominio.toLowerCase());
}

app.post('/api/formulario', async (req, res) => {
    const { nome, email, telefone, cnpj, necessidade, mensagem } = req.body;
    const threadId = `form_${Date.now()}`;

    try {
        if (!isEmailCorporativo(email)) {
            return res.status(400).json({
                success: false,
                message: 'Por favor, utilize um e-mail corporativo válido para solicitar o contato.'
            });
        }

        if (!validarTelefoneBR(telefone)) {
            return res.status(400).json({
                success: false,
                message: 'Telefone inválido. Por favor, digite o número completo com o DDD.'
            });
        }

        let cnpjLimpo = cnpj ? cnpj.replace(/\D/g, '') : '';
        const validacao = await consultarCNPJ(cnpjLimpo);
        
        if (!validacao.valido) {
            return res.status(400).json({
                success: false,
                message: validacao.erro || 'CNPJ não encontrado na Receita Federal.'
            });
        }

        let empresaReal = validacao.razao_social;
        const observacoes = `Mensagem original do cliente: ${mensagem}`;

        await pool.query(`
            INSERT INTO leads_cotacoes
            (nome_contato, empresa, cnpj, telefone, email, tipo_mercadoria, particularidades, canal_origem, status, thread_id, rota_origem, rota_destino)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            nome, empresaReal, cnpjLimpo, telefone, email, necessidade, observacoes,
            'Formulario Site', 'Novo Lead', threadId, 'A definir', 'A definir'
        ]);

        console.log(`🔔 NOTIFICAÇÃO: Novo lead via formulário! Empresa: ${empresaReal} | Contato: ${nome}`);
        await enviarAlertaWhatsApp(nome, empresaReal, telefone, necessidade);
        
        res.status(200).json({ success: true, message: 'Formulário enviado com sucesso!' });

    } catch (erro) {
        console.error("🚨 Erro na API do Formulário:", erro);
        res.status(500).json({ success: false, message: 'Ocorreu um erro interno ao enviar o formulário.' });
    }
});

// ==========================================
// ROTA DE AUTENTICAÇÃO (Mapeada com o Easypanel)
// ==========================================
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    // O código lê dinamicamente as chaves exatas que você salvou no Easypanel
    const senhasUsuarios = {
        'comercial@bmroadtransportes.com.br': process.env.PASS_COMERCIAL,
        'operacional@bmroadtransportes.com.br': process.env.PASS_OPERACIONAL,
        'vendas1@bmroadtransportes.com.br': process.env.PASS_VENDAS1
    };

    // 1. Verifica se o e-mail digitado está mapeado no sistema
    // 2. Verifica se a senha digitada é exatamente igual à do Easypanel
    if (senhasUsuarios[email] && senhasUsuarios[email] === password) {
        // Sucesso: Libera o token para o painel do CRM abrir
        res.json({ success: true, token: 'bmroad_auth_token_secure_xyz' });
    } else {
        // Falha: Credenciais inválidas
        res.status(401).json({ success: false, message: 'E-mail corporativo ou senha incorretos.' });
    }
});

// ==========================================
// ROTA DO DASHBOARD CRM (PROTEGIDA)
// ==========================================
app.get('/api/leads', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') {
        return res.status(401).json({ error: 'Acesso Negado. Faça o login.' });
    }

    try {
        const result = await pool.query('SELECT * FROM leads_cotacoes ORDER BY data_atualizacao DESC');
        res.json(result.rows);
    } catch (erro) {
        console.error("🚨 Erro ao buscar leads:", erro);
        res.status(500).json({ error: 'Erro ao conectar com o banco de dados.' });
    }
});

app.get('/', (req, res) => res.send('🚀 Motor IA BM Road : Blindado e Operacional!'));


// =================================================================
// ENDPOINT DE GESTÃO LOGÍSTICA: EFETIVAR LEAD COMO CONTA PERMANENTE
// =================================================================
app.post('/api/leads/:id/efetivar', async (req, res) => {
    const leadId = req.params.id;
    const { tipo_oportunidade } = req.body; // 'Carga Fracionada', 'Armazenagem Hub SP', 'Carga Dedicada', 'Outros'

    // Validação básica do tipo de serviço logístico
    const tiposValidos = ['Carga Fracionada', 'Armazenagem Hub SP', 'Carga Dedicada', 'Outros'];
    const servicoDefinido = tiposValidos.includes(tipo_oportunidade) ? tipo_oportunidade : 'Outros';

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Busca os dados brutos captados originalmente pela Isa ou formulário
        const resLead = await client.query('SELECT * FROM leads_cotacoes WHERE id = $1', [leadId]);
        if (resLead.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Lead bruto não encontrado.' });
        }
        const lead = resLead.rows[0];

        // Se o lead não tiver CNPJ, usamos um fallback seguro baseado no nome limpo da empresa
        const cnpjIdentificador = lead.cnpj ? lead.cnpj.replace(/\D/g, '') : lead.empresa.trim().toLowerCase();

        let empresaId;
        let contatoId;

        // 2. MECANISMO DE DEDUPLICAÇÃO DE EMPRESA: Verifica se o cliente corporativo já existe
        const resEmpresaExistente = await client.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjIdentificador]);
        
        if (resEmpresaExistente.rows.length > 0) {
            // Conta já mapeada no ecossistema
            empresaId = resEmpresaExistente.rows[0].id;
        } else {
            // Indústria Nova: Realiza a inserção definitiva no ecossistema
            const queryNovaEmpresa = `
                INSERT INTO empresas (razao_social, nome_fantasia, cnpj, status)
                VALUES ($1, $2, $3, 'Ativo') RETURNING id
            `;
            const resNovaEmpresa = await client.query(queryNovaEmpresa, [lead.empresa, lead.empresa, cnpjIdentificador]);
            empresaId = resNovaEmpresa.rows[0].id;
        }

        // 3. MECANISMO DE DEDUPLICAÇÃO DE CONTATO: Evita inserir a mesma pessoa repetidamente sob a mesma empresa
        const resContatoExistente = await client.query(
            'SELECT id FROM contatos WHERE empresa_id = $1 AND (telefone = $2 OR email = $3)',
            [empresaId, lead.telefone, lead.email]
        );

        if (resContatoExistente.rows.length > 0) {
            contatoId = resContatoExistente.rows[0].id;
        } else {
            // Conta os contatos vinculados para validar a regra de múltiplos contatos
            const resContagem = await client.query('SELECT COUNT(id) as total FROM contatos WHERE empresa_id = $1', [empresaId]);
            const totalContatos = parseInt(resContagem.rows[0].total);

            if (totalContatos >= 3) {
                console.log(`⚠️ ALERTA: Empresa ID ${empresaId} já possui ${totalContatos} contatos. Associando ao contato principal existente.`);
                const resPrimeiroContato = await client.query('SELECT id FROM contatos WHERE empresa_id = $1 ORDER BY id ASC LIMIT 1', [empresaId]);
                contatoId = resPrimeiroContato.rows[0].id;
            } else {
                // Insere novo contato operacional (Contato 1, 2 ou 3)
                const queryNovoContato = `
                    INSERT INTO contatos (empresa_id, nome, telefone, email, whatsapp)
                    VALUES ($1, $2, $3, $4, $5) RETURNING id
                `;
                const resNovoContato = await client.query(queryNovoContato, [empresaId, lead.nome_contato, lead.telefone, lead.email, lead.telefone]);
                contatoId = resNovoContato.rows[0].id;
            }
        }

        // 4. CRIAÇÃO DA OPORTUNIDADE LOGÍSTICA ESPECÍFICA
        const queryOportunidade = `
            INSERT INTO oportunidades (empresa_id, contato_id, tipo_oportunidade, status_comercial, rota_origem, rota_destino, peso_carga, volume_carga, valor_nf)
            VALUES ($1, $2, $3, 'Em Cotação', $4, $5, $6, $7, $8)
        `;
        await client.query(queryOportunidade, [empresaId, contatoId, servicoDefinido, lead.rota_origem, lead.rota_destino, lead.peso_carga, lead.volume_carga, lead.valor_nf]);

        // 5. ATUALIZAÇÃO DO STATUS DO LEAD BRUTO ORIGINAL
        // Salvamos as chaves de relacionamento no lead bruto para auditoria completa
        await client.query(
            'UPDATE leads_cotacoes SET status = $1, empresa_id = $2, contato_id = $3, data_atualizacao = CURRENT_TIMESTAMP WHERE id = $4',
            ['Efetivado / Qualificado', empresaId, contatoId, leadId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Empresa integrada e oportunidade gerada com sucesso!', empresa_id: empresaId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('🚨 Erro crítico no fluxo de conversão relacional:', error);
        res.status(500).json({ success: false, message: 'Falha interna ao processar a efetivação relacional.' });
    } finally {
        client.release();
    }
});

// =================================================================
// ENDPOINT DE VISÃO 360: DADOS COMPLETOS DA EMPRESA, CONTATOS E TRACKING
// =================================================================
app.get('/api/empresas/:id/360', async (req, res) => {
    const empresaId = req.params.id;

    try {
        // 1. Puxa os dados cadastrais da empresa
        const resEmpresa = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
        if (resEmpresa.rows.length === 0) {
            return res.status(404).json({ error: 'Empresa não encontrada no ecossistema.' });
        }

        // 2. Puxa todos os contatos vinculados a ela (Até 3)
        const resContatos = await pool.query('SELECT * FROM contatos WHERE empresa_id = $1 ORDER BY id ASC LIMIT 3', [empresaId]);

        // 3. Puxa todas as oportunidades e o pipeline de rastreamento operacional/faturamento
        const resOportunidades = await pool.query('SELECT * FROM oportunidades WHERE empresa_id = $1 ORDER BY data_atualizacao DESC', [empresaId]);

        res.json({
            empresa: resEmpresa.rows[0],
            contatos: resContatos.rows,
            oportunidades: resOportunidades.rows
        });

    } catch (error) {
        console.error('🚨 Erro ao buscar visão 360 da conta:', error);
        res.status(500).json({ error: 'Erro ao conectar com a base de dados.' });
    }
});


// ==========================================
// ROTAS DE GESTÃO: LISTAGEM DE EMPRESAS E CONTATOS
// ==========================================
app.get('/api/empresas', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    try {
        const result = await pool.query('SELECT * FROM empresas ORDER BY data_criacao DESC');
        res.json(result.rows);
    } catch (erro) {
        console.error("🚨 Erro ao buscar empresas:", erro);
        res.status(500).json({ error: 'Erro ao conectar com o banco de dados.' });
    }
});

app.get('/api/contatos', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    try {
        // Puxa os contatos e já traz o nome da empresa associada a eles
        const result = await pool.query(`
            SELECT c.*, e.razao_social as empresa_nome 
            FROM contatos c 
            LEFT JOIN empresas e ON c.empresa_id = e.id 
            ORDER BY c.nome ASC
        `);
        res.json(result.rows);
    } catch (erro) {
        console.error("🚨 Erro ao buscar contatos:", erro);
        res.status(500).json({ error: 'Erro ao conectar com o banco de dados.' });
    }
});

// ==========================================
// ROTA DE ATUALIZAÇÃO DO STATUS COMERCIAL (CRM)
// ==========================================
app.put('/api/oportunidades/:id/status', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });

    const opId = req.params.id;
    const { status_comercial } = req.body;

    try {
        await pool.query(
            'UPDATE oportunidades SET status_comercial = $1, data_atualizacao = CURRENT_TIMESTAMP WHERE id = $2',
            [status_comercial, opId]
        );
        res.json({ success: true, message: 'Status atualizado com sucesso!' });
    } catch (erro) {
        console.error("🚨 Erro ao atualizar status da oportunidade:", erro);
        res.status(500).json({ error: 'Erro interno ao atualizar.' });
    }
});

// Edição de Oportunidade (Atualizada com Frete Negociado e Tipo de Tabela)
app.put('/api/oportunidades/:id/dados', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    const { rota_origem, rota_destino, peso_carga, volume_carga, valor_nf, valor_frete, tabela_preco } = req.body;
    try {
        const valNfTratado = valor_nf === '' ? null : valor_nf;
        const valFreteTratado = valor_frete === '' ? null : valor_frete;
        
        await pool.query(
            `UPDATE oportunidades SET 
                rota_origem = COALESCE($1, rota_origem), 
                rota_destino = COALESCE($2, rota_destino), 
                peso_carga = COALESCE($3, peso_carga), 
                volume_carga = COALESCE($4, volume_carga), 
                valor_nf = COALESCE($5, valor_nf),
                valor_frete = COALESCE($6, valor_frete),
                tabela_preco = COALESCE($7, tabela_preco),
                data_atualizacao = CURRENT_TIMESTAMP 
             WHERE id = $8`,
            [rota_origem, rota_destino, peso_carga, volume_carga, valNfTratado, valFreteTratado, tabela_preco, req.params.id]
        );
        res.json({ success: true });
    } catch (erro) { 
        console.error("🚨 Erro ao atualizar oportunidade:", erro);
        res.status(500).json({ error: 'Erro ao atualizar oportunidade.' }); 
    }
});

// ==========================================
// ROTAS DE EDIÇÃO (ENRIQUECIMENTO DE DADOS)
// ==========================================

// Edição de Empresa
app.put('/api/empresas/:id', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    const { razao_social, cnpj, segmento, porte, endereco, site } = req.body;
    try {
        await pool.query(
            `UPDATE empresas SET razao_social = COALESCE($1, razao_social), cnpj = COALESCE($2, cnpj), segmento = COALESCE($3, segmento), porte = COALESCE($4, porte), endereco = COALESCE($5, endereco), site = COALESCE($6, site), data_atualizacao = CURRENT_TIMESTAMP WHERE id = $7`,
            [razao_social, cnpj, segmento, porte, endereco, site, req.params.id]
        );
        res.json({ success: true });
    } catch (erro) { res.status(500).json({ error: 'Erro ao atualizar empresa.' }); }
});

// Edição de Contato
app.put('/api/contatos/:id', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    const { nome, telefone, email, cargo } = req.body;
    try {
        await pool.query(
            `UPDATE contatos SET nome = COALESCE($1, nome), telefone = COALESCE($2, telefone), email = COALESCE($3, email), cargo = COALESCE($4, cargo), data_atualizacao = CURRENT_TIMESTAMP WHERE id = $5`,
            [nome, telefone, email, cargo, req.params.id]
        );
        res.json({ success: true });
    } catch (erro) { res.status(500).json({ error: 'Erro ao atualizar contato.' }); }
});

// Edição de Oportunidade
app.put('/api/oportunidades/:id/dados', async (req, res) => {
    const token = req.headers.authorization;
    if (token !== 'Bearer bmroad_auth_token_secure_xyz') return res.status(401).json({ error: 'Acesso Negado.' });
    
    const { rota_origem, rota_destino, peso_carga, volume_carga, valor_nf } = req.body;
    try {
        const valorTratado = valor_nf === '' ? null : valor_nf;
        await pool.query(
            `UPDATE oportunidades SET rota_origem = COALESCE($1, rota_origem), rota_destino = COALESCE($2, rota_destino), peso_carga = COALESCE($3, peso_carga), volume_carga = COALESCE($4, volume_carga), valor_nf = COALESCE($5, valor_nf), data_atualizacao = CURRENT_TIMESTAMP WHERE id = $6`,
            [rota_origem, rota_destino, peso_carga, volume_carga, valorTratado, req.params.id]
        );
        res.json({ success: true });
    } catch (erro) { res.status(500).json({ error: 'Erro ao atualizar oportunidade.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
