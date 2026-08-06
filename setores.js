// =========================================================================
// MAPEAMENTO CIDADE → REGIÃO (SETOR), usado pelo backend pra filtrar
// leads/empresas por região ANTES de paginar (evita o bug de "página
// carregada não tem resultado da região filtrada, mas a próxima tem").
//
// ⚠️ Esta é uma cópia do mesmo dicionário que existe em public/app.js.
// Se adicionar/mudar uma cidade, atualize os dois arquivos juntos.
// =========================================================================

export const CIDADE_PARA_SETOR = {
    "diadema": "R1", "guarulhos": "R1", "maua": "R1", "ribeirao pires": "R1", "santo andre": "R1",
    "sao bernardo do campo": "R1", "sao caetano do sul": "R1", "sao paulo": "R1", "bras": "R1",
    "barueri": "R2", "carapicuiba": "R2", "cotia": "R2", "osasco": "R2", "taboao da serra": "R2",
    "aruja": "R3", "embu": "R3", "itapecirica da serra": "R3", "itapevi": "R3", "jandira": "R3", "santana de parnaiba": "R3",
    "cabreuva": "R4A", "ibiuna": "R4A", "mairinque": "R4A", "salto": "R4A", "sorocaba": "R4A", "sao roque": "R4A", "votorantim": "R4A",
    "caieiras": "R4B", "cajamar": "R4B", "franco da rocha": "R4B", "mairipora": "R4B",
    "americana": "R4C", "campinas": "R4C", "campo limpo paulista": "R4C", "elias fausto": "R4C",
    "hortolandia": "R4C", "indaiatuba": "R4C", "itatiba": "R4C", "itupeva": "R4C", "jundiai": "R4C",
    "limeira": "R4C", "monte mor": "R4C", "santa barbara do oeste": "R4C", "sumare": "R4C",
    "valinhos": "R4C", "vargem grande paulista": "R4C", "varzea paulista": "R4C", "vinhedo": "R4C",
    "cubatao": "R5", "guaruja": "R5", "santos": "R5", "sao vicente": "R5",
    "atibaia": "R6A", "bom jesus dos perdoes": "R6A", "braganca paulista": "R6A",
    "camanducaia": "R6A", "cambui": "R6A", "extrema": "R6A",
    "pouso alegre": "R6A", "santa rita do sapucai": "R6A", "itajuba": "R6A",
    "boituva": "R6B", "cerquilho": "R6B", "ipero": "R6B", "itapeva": "R6B", "porto feliz": "R6B", "tatui": "R6B",
    "araras": "R6C", "piracicaba": "R6C", "tiete": "R6C", "vargem": "R6C",
    "biritiba mirim": "R7", "ferraz de vasconcelos": "R7", "itaquaquecetuba": "R7", "mogi das cruzes": "R7", "poa": "R7", "santa isabel": "R7", "suzano": "R7",
    "cacapava": "R8", "guararema": "R8", "jacarei": "R8", "santa branca": "R8", "sao jose dos campos": "R8", "taubate": "R8",
    "belo horizonte": "MG", "bh": "MG", "betim": "MG", "contagem": "MG", "jacutinga": "MG",
    "pocos de caldas": "MG", "uberlandia": "MG",
    "ribeirao preto": "R_INT"
};

export function normalizarCidade(cidade) {
    if (!cidade) return "";
    return String(cidade).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function getSetorPorCidade(cidade) {
    if (!cidade || String(cidade).trim() === '') return "OUTRAS";
    const norm = normalizarCidade(cidade);
    for (const [key, value] of Object.entries(CIDADE_PARA_SETOR)) {
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(norm)) return value;
    }
    return "OUTRAS";
}
