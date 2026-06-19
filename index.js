import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from './db.js';
import { isaSystemInstruction } from './isaPrompt.js';

// Carrega as variáveis de ambiente (necessário para testes locais, no Easypanel já estão no Env)
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Inicializa a IA com a chave que está no cofre do Easypanel
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define as Ferramentas (Functions) que a ISA pode usar
const tools = [{
    functionDeclarations: [{
        name: "salvar_dados_crm",
        description: "Guarda ou atualiza as informações do lead na base de dados. Deve ser chamada silenciosamente sempre que a Isa conseguir extrair um ou mais dados (CNPJ, origem, destino, nome, etc.).",
        parameters: {
            type: "OBJECT",
            properties: {
                cnpj: { type: "STRING", description: "CNPJ da empresa (apenas números ou formato padrão)" },
                empresa: { type: "STRING", description: "Nome da empresa" },
                rota_origem: { type: "STRING", description: "Cidade/Estado de origem" },
                rota_destino: { type: "STRING", description: "Cidade/Estado de destino" },
                nome_contato: { type: "STRING", description: "Nome do cliente com quem está a falar" },
                telefone: { type: "STRING", description: "Telefone ou WhatsApp do cliente" },
                peso_carga: { type: "STRING", description: "Peso estimado da carga" },
                volume_carga: { type: "STRING", description: "Volume ou dimensões da carga" },
                valor_nf: { type: "NUMBER", description: "Valor da Nota Fiscal (apenas números)" }
            }
        }
    }]
}];

// Rota principal de comunicação com o Site
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];
    // O threadId identifica a sessão do utilizador para sabermos se atualizamos ou criamos um novo lead
    const threadId = req.body.threadId || `sessao_${Date.now()}`; 

    try {
        // Prepara o modelo Gemini com as nossas regras rigorosas
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash", // Modelo rápido, estável e perfeito para Function Calling
            tools: tools,
            systemInstruction: isaSystemInstruction,
        });

        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(userMessage);
        
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls(); // Verifica se a IA decidiu usar a ferramenta

        // Se a ISA percebeu que o cliente enviou um dado, ela aciona o banco de dados
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            
            if (call.name === "salvar_dados_crm") {
                const args = call.args;

                // LÓGICA DE CRM: Verifica se esta conversa já existe no PostgreSQL
                const queryVerifica = 'SELECT id FROM leads_cotacoes WHERE thread_id = $1';
                const resVerifica = await pool.query(queryVerifica, [threadId]);

                if (resVerifica.rows.length > 0) {
                    // ATUALIZA O LEAD EXISTENTE (COALESCE garante que só atualizamos os dados que a IA enviou agora)
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
                    // CRIA UM NOVO LEAD
                    await pool.query(`
                        INSERT INTO leads_cotacoes 
                        (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    `, [args.cnpj, args.empresa, args.rota_origem, args.rota_destino, args.nome_contato, args.telefone, args.peso_carga, args.volume_carga, args.valor_nf, threadId]);
                }

                // Avisa a IA de que o dado foi guardado para que ela faça a próxima pergunta do funil
                const functionResponseResult = await chat.sendMessage([{
                    functionResponse: { 
                        name: "salvar_dados_crm", 
                        response: { success: true, message: "Dados atualizados. Faça a próxima pergunta natural." } 
                    }
                }]);
                aiResponseText = functionResponseResult.response.text();
            }
        }

        // Devolve a resposta e o histórico atualizado ao frontend do site
        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory, threadId: threadId });

    } catch (error) {
        console.error("🚨 Erro na API do Chat:", error);
        res.status(500).json({ 
            reply: "Peço imensa desculpa, estou a ter uma pequena falha na minha comunicação. Podemos retomar daqui a instantes?", 
            history: history,
            threadId: threadId
        });
    }
});

// Rota de Teste para o Easypanel
app.get('/', (req, res) => res.send('🚀 Motor IA da BM Road Online e Operacional!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a rodar na porta ${PORT}`));
