const {NewsAgent}=require('./src/agents/NewsAgent');
const {OpenRouterClient}=require('./src/llm/OpenRouterClient');
require('dotenv').config();

const llm=new OpenRouterClient({
    apiKey:process.env.OPENROUTER_API_KEY,
    model:process.env.OPENROUTER_MODEL,
    onMetric: console.log
});

const agent=new NewsAgent({apiToken:process.env.NEWS_API_KEY,llm});

async function main() {
    const news = await agent._fetchNews('BTC');
    console.log('News length:', news.length);
    const headlines = news.map(a => '- ' + a.title).join('\n');
    console.log(headlines);

    const systemPrompt = [
        `You are a cryptocurrency market sentiment analyzer.`,
        `Evaluate the following recent news headlines for BTC.`,
        `Determine the overall market sentiment impact: LONG (bullish), SHORT (bearish), or NEUTRAL.`,
        `Calculate confidence between 0.0 and 1.0.`,
        `Provide a brief 1-sentence reasoning IN RUSSIAN.`,
        `Respond ONLY with JSON matching this exact schema:`,
        `{ "direction": "LONG"|"SHORT"|"NEUTRAL", "confidence": number, "reasoning": "string" }`
    ].join('\n');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Headlines for BTC:\n${headlines}` }
    ];

    const result = await llm.askJson(messages);
    console.log('LLM Result:', result);
}

main().catch(console.error);
