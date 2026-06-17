const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuração do Banco de Dados PostgreSQL (Micro-CRM)
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
});

// Cria a tabela de Leads automaticamente se ela não existir
async function setupDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                cnpj VARCHAR(50) NOT NULL,
                origem VARCHAR(255),
                destino VARCHAR(255),
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Tabela de CRM verificada/criada com sucesso.");
    } catch (err) {
        console.error("❌ Erro ao criar tabela no PostgreSQL:", err);
    }
}
setupDatabase();

// 2. Configuração da Inteligência Artificial (Gemini)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Ensinamos ao Gemini o que ele pode fazer (Function Calling para o CRM)
const tools = [{
    functionDeclarations: [{
        name: "salvar_lead_crm",
        description: "Salva os dados do lead no banco de dados CRM. Chame esta função APENAS quando o cliente já tiver fornecido o Nome da Empresa e o CNPJ.",
        parameters: {
            type: "OBJECT",
            properties: {
                nome: { type: "STRING", description: "Nome do cliente ou da empresa" },
                cnpj: { type: "STRING", description: "CNPJ fornecido pelo cliente" },
                origem: { type: "STRING", description: "Cidade/Estado de origem (se mencionado)" },
                destino: { type: "STRING", description: "Cidade/Estado de destino (se mencionado)" }
            },
            required: ["nome", "cnpj"]
        }
    }]
}];

const instrucoesSistema = `
Você é a assistente virtual de inteligência artificial da BM Road Transportes.
Sua missão é atender clientes B2B (empresas industriais) no site.
Sua linguagem deve ser profissional, prestativa e objetiva.

FLUXO DE ATENDIMENTO:
1. O cliente pedirá uma cotação de frete.
2. Pergunte a cidade de Origem e Destino (lembre-se que o foco é MG para SP).
3. Após saber a rota, diga que precisa do Nome da Empresa e do CNPJ para formalizar a tabela de preços.
4. ASSIM QUE O CLIENTE INFORMAR O NOME E CNPJ, use a ferramenta 'salvar_lead_crm' para guardar no banco de dados.
5. Após usar a ferramenta, avise ao cliente que os dados foram registrados e um executivo de contas humano entrará em contato em breve via WhatsApp ou E-mail com os valores exatos.
`;

// 3. Rota de Comunicação com o Site
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            tools: tools,
            systemInstruction: instrucoesSistema,
        });

        // Inicia o chat com a memória da conversa atual
        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(userMessage);
        
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls;

        // Se a IA decidiu que é hora de salvar no CRM:
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            if (call.name === "salvar_lead_crm") {
                const { nome, cnpj, origem, destino } = call.args;
                
                // Insere no banco PostgreSQL
                await pool.query(
                    'INSERT INTO leads (nome, cnpj, origem, destino) VALUES ($1, $2, $3, $4)',
                    [nome, cnpj, origem || 'Não informado', destino || 'Não informado']
                );
                console.log(`✅ Novo Lead Salvo! Empresa: ${nome} - CNPJ: ${cnpj}`);

                // Responde à IA dizendo que deu certo, para ela formular a resposta final
                const functionResponseResult = await chat.sendMessage([{
                    functionResponse: { name: "salvar_lead_crm", response: { success: true } }
                }]);
                
                aiResponseText = functionResponseResult.response.text();
            }
        }

        // Devolve a resposta e a memória atualizada para o site
        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory });

    } catch (error) {
        console.error("Erro na API do Chat:", error);
        res.status(500).json({ reply: "Desculpe, nosso sistema está passando por uma atualização rápida. Pode tentar novamente em instantes?", history });
    }
});

// Rota de teste
app.get('/', (req, res) => res.send('API BM Road 100% Operacional'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a rodar na porta ${PORT}`));
