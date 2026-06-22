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
                valor_nf: { type: "NUMBER", description: "Valor da Nota Fiscal (apenas números)" }
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

// NOVO MOTOR V8: Tripla Validação de CNPJ (Implacável mas Inteligente)
async function consultarCNPJ(cnpjOriginal) {
    if (!cnpjOriginal) return { valido: false, erro: "CNPJ é obrigatório." };
    const cnpjNumeros = cnpjOriginal.replace(/\D/g, '');
    if (cnpjNumeros.length !== 14) return { valido: false, erro: "O CNPJ precisa ter exatamente 14 números." };

    // Tentativa 1: CNPJ.ws (Melhor compatibilidade com servidores VPS)
    try {
        const res1 = await fetch(`https://publica.cnpj.ws/cnpj/${cnpjNumeros}`);
        if (res1.ok) {
            const data1 = await res1.json();
            return { valido: true, razao_social: data1.razao_social };
        }
        if (res1.status === 404 || res1.status === 400) {
            return { valido: false, erro: "CNPJ não existe na base da Receita." };
        }
    } catch (e) { console.log("Tentativa 1 falhou. Tentando próxima..."); }

    // Tentativa 2: ReceitaWS
    try {
        const res2 = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpjNumeros}`);
        if (res2.ok) {
            const data2 = await res2.json();
            if (data2.status === "ERROR") return { valido: false, erro: "CNPJ rejeitado pela Receita." };
            return { valido: true, razao_social: data2.nome };
        }
    } catch (e) { console.log("Tentativa 2 falhou. Tentando próxima..."); }

    // Tentativa 3: BrasilAPI
    try {
        const res3 = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNumeros}`);
        if (res3.ok) {
            const data3 = await res3.json();
            return { valido: true, razao_social: data3.razao_social };
        }
        if (res3.status === 404 || res3.status === 400) {
             return { valido: false, erro: "CNPJ inválido ou não encontrado." };
        }
    } catch (e) { console.log("Tentativa 3 falhou."); }

    // Se o CNPJ for falso de verdade, as APIs retornam 404 e caem nos ifs acima.
    // Se o código chegou aqui, as 3 APIs bloquearam nosso servidor momentaneamente.
    // Para mantermos a trava RÍGIDA de que você não abre mão, não deixamos passar de jeito nenhum.
    return { valido: false, erro: "Instabilidade na verificação com a Receita. Confirme o CNPJ ou tente em instantes." };
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
                        `, [args.cnpj, args.empresa, args.rota_origem, args.rota_destino, args.nome_contato, args.telefone, args.peso_carga, args.volume_carga, args.valor_nf, threadId]);
                    } else {
                        await pool.query(`
                            INSERT INTO leads_cotacoes
                            (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        `, [args.cnpj, args.empresa, args.rota_origem, args.rota_destino, args.nome_contato, args.telefone, args.peso_carga, args.volume_carga, args.valor_nf, threadId]);
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

// --- FUNÇÃO AUXILIAR: VALIDAÇÃO DE E-MAIL CORPORATIVO ---
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

// --- ROTA DO FORMULÁRIO ESTÁTICO DO SITE ---
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

        // --- TRAVA DE SEGURANÇA B2B IMPLACÁVEL ---
        let cnpjLimpo = cnpj ? cnpj.replace(/\D/g, '') : '';
        const validacao = await consultarCNPJ(cnpjLimpo);
        
        // Bloqueia se for falso, incompleto ou inexistente
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
            nome,
            empresaReal,
            cnpjLimpo,
            telefone,
            email,
            necessidade,
            observacoes,
            'Formulario Site',
            'Novo Lead',
            threadId,
            'A definir',
            'A definir'
        ]);

        console.log(`🔔 NOTIFICAÇÃO: Novo lead via formulário! Empresa: ${empresaReal} | Contato: ${nome}`);

        res.status(200).json({ success: true, message: 'Formulário enviado com sucesso!' });

    } catch (erro) {
        console.error("🚨 Erro na API do Formulário:", erro);
        res.status(500).json({ success: false, message: 'Ocorreu um erro interno ao enviar o formulário.' });
    }
});

app.get('/', (req, res) => res.send('🚀 Motor IA BM Road : Blindado e Operacional!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
