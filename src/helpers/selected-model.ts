/**
 * Función para centralizar el modelo a usar en el proyecto
 *
 * También agregué otras opciones si lo quieres cambiar
 */

// Groq:
// npm i @ai-sdk/groq
import { groq } from '@ai-sdk/groq';

// Anthropic:
// npm i @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';

// OpenAI:
// npm i @ai-sdk/openai
import { openai } from '@ai-sdk/openai';

// Gemini:
// npm i @ai-sdk/google
import { google } from '@ai-sdk/google';

// Ollama:
// npm i ollama-ai-provider-v2
// A diferencia de los anteriores, este es un proveedor comunitario.
import { ollama } from 'ollama-ai-provider-v2';

// Groq: Este tiene un pequeño frretier y por eso funciona
// export const model = groq('openai/gpt-oss-20b');    // Ctrl + espaciadora, salen los modelos
// export const model = groq('openai/gpt-oss-120b');

// Anthropic: En este hay que comprar creditos si no no funciona
// export const model = anthropic('claude-haiku-4-5');   // Ctrl + espaciadora, salen los modelos

// OpenAI:
// export const model = openai('gpt-5-mini');

// Gemini:
// export const model = google('gemini-2.5-flash');

// Ollama:
 export const model = ollama('gpt-oss:20b');
