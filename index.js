const express = require('express');
const cors = require('cors');
const app = express();

// Permite receber mensagens do chat do seu site
app.use(cors());
app.use(express.json());

// Rota de teste para garantir que está tudo a funcionar
app.get('/', (req, res) => {
  res.send('O Motor IA da BM Road está Online e Operacional!');
});

// A porta onde o servidor vai rodar (o Easypanel vai ler isto)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a rodar na porta ${PORT}`);
});
