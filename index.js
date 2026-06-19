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

const tools = [{
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

// 1. Valida Telefone Fixo (10 dígitos) ou Celular (11 dígitos) com DDD válido
function validarTelefoneBR(telefone) {
    if (!telefone) return true; // Se não enviou, passa (avalia só se enviou)
    const numeros = telefone.replace(/\D/g, ''); // Remove tudo que não é número
    if (numeros.length !== 10 && numeros.length !== 11) return false;
    
    const ddd = parseInt(numeros.substring(0, 2));
    if (ddd < 11 || ddd > 99) return false; // DDD inválido no Brasil

    // Se for celular (11 dígitos), o terceiro dígito tem que ser 9
    if (numeros.length === 11 && numeros.charAt(2) !== '9') return false;
    
    return true;
}

// 2. Consulta CNPJ na BrasilAPI
async function consultarCNPJ(cnpjOriginal) {
    if (!cnpjOriginal) return { valido: true }; // Passa se não enviou
    const cnpjNumeros = cnpjOriginal.replace(/\D/g, '');
    if (cnpjNumeros.length !== 14) return { valido: false, erro: "O CNPJ precisa ter 14 números." };

    try {
        const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNumeros}`);
        if (!response.ok) return { valido: false, erro: "CNPJ não encontrado na Receita Federal." };
        const data = await response.json();
        return { valido: true, razao_social: data.razao_social };
    } catch (error) {
        console.error("Erro na BrasilAPI:", error);
        return { valido: true }; // Se a API cair, deixamos passar para não bloquear a venda
    }
}

// --- ROTA PRINCIPAL DO CHAT ---
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];
    const threadId = req.body.threadId || `sessao_${Date.now()}`; 

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash-lite-preview-02-05", // Modelo ultra-rápido e económico
            tools: tools,
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

                // BLOCO DE VALIDAÇÃO DE SEGURANÇA
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
                        args.empresa = validacaoCnpj.razao_social; // Auto-preenche o nome correto da empresa
                    }
                }

                // SÓ SALVA NO BANCO SE AS VALIDAÇÕES PASSAREM
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

                // Devolve a resposta (Sucesso ou Erro de Validação) para a IA processar e falar com o humano
                const functionResponseResult = await chat.sendMessage([{
                    functionResponse: { 
                        name: "salvar_dados_crm", 
                        response: { success: podeSalvar, instrucao: mensagemParaIA } 
                    }
                }]);
                aiResponseText = functionResponseResult.response.text();
            }
        }

        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory, threadId: threadId });

    } catch (error) {
        console.error("🚨 Erro na API do Chat:", error);
        res.status(500).json({ reply: "Peço imensa desculpa, estou a ter uma pequena falha de conexão. Podemos retomar?", history, threadId });
    }
});

app.get('/', (req, res) => res.send('🚀 Motor IA BM Road: Blindado e Operacional!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
