const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuração do Banco de Dados PostgreSQL
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
});

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

// 2. Configuração da IA (Usando o modelo que está na sua lista: gemini-2.5-flash)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
    functionDeclarations: [{
        name: "salvar_lead_crm",
        description: "Salva os dados do lead no banco de dados CRM.",
        parameters: {
            type: "OBJECT",
            properties: {
                nome: { type: "STRING" },
                cnpj: { type: "STRING" },
                origem: { type: "STRING" },
                destino: { type: "STRING" }
            },
            required: ["nome", "cnpj"]
        }
    }]
}];

const instrucoesSistema = "Você é a assistente virtual da BM Road Transportes. Seja profissional e objetiva. Ao receber nome e CNPJ, use a ferramenta salvar_lead_crm.";

// 3. Rota de Chat
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const history = req.body.history || [];

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash", // MODELO CORRIGIDO AQUI
            tools: tools,
            systemInstruction: instrucoesSistema,
        });

        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(userMessage);
        
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls;

        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            if (call.name === "salvar_lead_crm") {
                const { nome, cnpj, origem, destino } = call.args;
                await pool.query(
                    'INSERT INTO leads (nome, cnpj, origem, destino) VALUES ($1, $2, $3, $4)',
                    [nome, cnpj, origem || 'Não informado', destino || 'Não informado']
                );
                const functionResponseResult = await chat.sendMessage([{
                    functionResponse: { name: "salvar_lead_crm", response: { success: true } }
                }]);
                aiResponseText = functionResponseResult.response.text();
            }
        }

        const updatedHistory = await chat.getHistory();
        res.json({ reply: aiResponseText, history: updatedHistory });

    } catch (error) {
        console.error("Erro na API do Chat:", error);
        res.status(500).json({ reply: "Desculpe, nosso sistema está passando por uma atualização rápida.", history });
    }
});

app.get('/', (req, res) => res.send('API BM Road 100% Operacional'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a rodar na porta ${PORT}`));
