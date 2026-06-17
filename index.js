const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

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
                nome_empresa VARCHAR(255),
                cnpj VARCHAR(50),
                nome_pessoa VARCHAR(255),
                telefone VARCHAR(50),
                origem VARCHAR(255),
                destino VARCHAR(255),
                peso VARCHAR(50),
                volume VARCHAR(255),
                valor_nf VARCHAR(50),
                recorrencia VARCHAR(50),
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } catch (err) { console.error("Erro no DB:", err); }
}
setupDatabase();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
    functionDeclarations: [
        {
            name: "verificar_cliente",
            description: "Consulta o banco de dados pelo CNPJ para ver se já é cliente.",
            parameters: { type: "OBJECT", properties: { cnpj: { type: "STRING" } }, required: ["cnpj"] }
        },
        {
            name: "salvar_lead_crm",
            description: "Salva todos os dados do lead no CRM ao final do atendimento.",
            parameters: {
                type: "OBJECT",
                properties: {
                    nome_empresa: { type: "STRING" }, cnpj: { type: "STRING" },
                    nome_pessoa: { type: "STRING" }, telefone: { type: "STRING" },
                    origem: { type: "STRING" }, destino: { type: "STRING" },
                    peso: { type: "STRING" }, volume: { type: "STRING" },
                    valor_nf: { type: "STRING" }, recorrencia: { type: "STRING" }
                }
            }
        },
        {
            name: "calcular_frete",
            description: "Calcula o frete com base nos dados. EM CONSTRUÇÃO.",
            parameters: { type: "OBJECT", properties: { peso: { type: "STRING" }, rota: { type: "STRING" } } }
        }
    ]
}];

const instrucoesSistema = `
Você é a Isa, assistente humana e muito prestativa da BM Road Transportes.
IDENTIDADE: Amigável, natural, nunca soa como robô. Se a resposta for longa ou complexa, finja que está a escrever ("...") por alguns segundos.
FLUXO OBRIGATÓRIO:
1. Identifique o cliente: Pergunte Nome da Empresa e CNPJ. Use a ferramenta 'verificar_cliente'.
2. Se for cliente antigo, cumprimente calorosamente. Se novo, continue o fluxo.
3. Solicite Origem e Destino.
4. Solicite Nome da pessoa e Telefone de contato.
5. Solicite Peso, Volume, Valor da NF e se a carga é recorrente ou única.
6. Finalização: Agradeça e avise que um consultor entrará em contato.
REGRAS: 
- NUNCA diga "Salvei no CRM" ou termos técnicos.
- Não peça informações que já foram dadas anteriormente.
- Só use 'salvar_lead_crm' no último passo.
`;

app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools, systemInstruction: instrucoesSistema });
        const chat = model.startChat({ history: history });
        
        const result = await chat.sendMessage(message);
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls;

        if (functionCalls) {
            for (const call of functionCalls) {
                if (call.name === "verificar_cliente") {
                    const resDb = await pool.query('SELECT nome_empresa FROM leads WHERE cnpj = $1 LIMIT 1', [call.args.cnpj]);
                    const resposta = resDb.rows.length > 0 ? `Cliente recorrente: ${resDb.rows[0].nome_empresa}` : "Cliente novo";
                    const response = await chat.sendMessage([{ functionResponse: { name: "verificar_cliente", response: { status: resposta } } }]);
                    aiResponseText = response.response.text();
                }
                if (call.name === "salvar_lead_crm") {
                    const args = call.args;
                    await pool.query('INSERT INTO leads (nome_empresa, cnpj, nome_pessoa, telefone, origem, destino, peso, volume, valor_nf, recorrencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
                        [args.nome_empresa, args.cnpj, args.nome_pessoa, args.telefone, args.origem, args.destino, args.peso, args.volume, args.valor_nf, args.recorrencia]);
                    aiResponseText = "Perfeito, anotei tudo! Um de nossos consultores entrará em contato em breve para fechar os detalhes.";
                }
                if (call.name === "calcular_frete") {
                    aiResponseText = "Estou a processar os dados da rota... em breve teremos o valor exato, mas já anotei o seu pedido!";
                }
            }
        }
        res.json({ reply: aiResponseText, history: await chat.getHistory() });
    } catch (error) {
        res.status(500).json({ reply: "A Isa está a recalibrar a rota, tente em um segundo!" });
    }
});

app.listen(3000, () => console.log("Servidor ativo"));
