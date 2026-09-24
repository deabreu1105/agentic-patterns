/**
 * PATRÓN: Enrutamiento - Routing (con un modelo de evaluación)
 * ------------------------------------------------------------
 * Antes de responder hay que decidir QUIÉN responde. Ese primer paso
 * —clasificar y despachar— es el patrón Routing.
 *
 * El error típico es resolverlo con un LLM generalista: le pedimos "dame
 * la categoría" y nos devuelve prosa. A veces acierta, a veces inventa una
 * categoría que no existe, y nunca nos dice qué tan seguro está.
 *
 * Jev (typesafe-ai/jev) es un modelo de EVALUACIÓN, no de generación: no
 * escribe texto, responde preguntas tipadas contra un estado compartido y
 * devuelve la elección junto con su distribución de probabilidad.
 *
 *   A) Sin router tipado → generateText pide la categoría en prosa
 *   B) Con Jev           → elección garantizada dentro del enum + confianza
 *
 * La confianza es lo que habilita el guardrail: si el modelo no está seguro,
 * el ticket va a un humano en vez de a la cola equivocada.
 */

// experimental_evaluate: evalúa preguntas tipadas contra UN estado compartido.
// Ojo: la API es experimental y puede cambiar incluso en versiones patch.
import { experimental_evaluate as evaluate, generateText } from 'ai';

// El gateway de Vercel es quien expone los modelos de evaluación.
// Necesita AI_GATEWAY_API_KEY en el .env.
import { gateway } from '@ai-sdk/gateway';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LA MESA DE SOPORTE — los tickets que hay que enrutar
// ---------------------------------------------------------------------------

type Ticket = {
  id: string;
  mensaje: string;
  plan: 'gratis' | 'pro' | 'empresa';
  diasDesdeCompra: number;
  intentosPrevios: number;
};

/**
 * Cuatro casos elegidos a propósito:
 *   t-01 es obvio, t-02 es grave pero claro, t-03 es genuinamente ambiguo
 *   (¿cuenta o técnico?) y t-04 mezcla un problema técnico con una exigencia
 *   de devolución. Los dos últimos son los que separan a un router tipado
 *   de uno que solo "suena" bien.
 */
const TICKETS: Ticket[] = [
  {
    id: 't-01',
    mensaje:
      'Me cobraron dos veces el curso de TypeScript este mes. Veo dos cargos ' +
      'idénticos en la tarjeta con la misma fecha.',
    plan: 'pro',
    diasDesdeCompra: 3,
    intentosPrevios: 0,
  },
  {
    id: 't-02',
    mensaje:
      'El reproductor se queda en pantalla negra en todas las lecciones desde ' +
      'ayer. Probé en dos navegadores y borrando caché. No puedo avanzar nada.',
    plan: 'empresa',
    diasDesdeCompra: 40,
    intentosPrevios: 3,
  },
  {
    id: 't-03',
    mensaje:
      'No logro entrar a mi cuenta. Pongo mi correo y contraseña y el botón de ' +
      'iniciar sesión no hace nada, se queda girando.',
    plan: 'gratis',
    diasDesdeCompra: 120,
    intentosPrevios: 1,
  },
  {
    id: 't-04',
    mensaje:
      'Llevo una semana sin poder ver el curso por un error de la plataforma y ' +
      'nadie me responde. Ya perdí la paciencia: quiero que me devuelvan mi dinero.',
    plan: 'pro',
    diasDesdeCompra: 9,
    intentosPrevios: 2,
  },
];

// ---------------------------------------------------------------------------
// LA TAXONOMÍA — compartida por las dos ramas para que la comparación sea justa
// ---------------------------------------------------------------------------

/**
 * `as const` no es decorativo: hace que las claves sean tipos literales, y por
 * eso más abajo `answers.departamento.choice` queda tipado como la unión
 * 'facturacion' | 'tecnico' | 'cuenta' | 'otro' en vez de un string cualquiera.
 */
const DEPARTAMENTOS = {
  facturacion: 'Cobros duplicados, facturas, suscripciones y reembolsos.',
  tecnico: 'Fallos de la plataforma: video, descargas, errores de la app.',
  cuenta: 'Acceso, contraseñas, permisos y datos del perfil.',
  otro: 'Cualquier cosa que no encaje en las anteriores.',
} as const;

/** Niveles ORDENADOS de menor a mayor gravedad. El índice 0 es el más leve. */
const SEVERIDAD = [
  'Consulta informativa, nada está roto',
  'Molesto, pero existe una forma de seguir trabajando',
  'Bloqueado, sin manera de avanzar',
  'Bloqueado y además con dinero o datos de por medio',
] as const;

// ---------------------------------------------------------------------------
//! A) SIN ROUTER TIPADO — pedirle la categoría a un LLM generalista
// ---------------------------------------------------------------------------

async function sinRouterTipado() {
  console.log(
    '\n═══ A) SIN ROUTER TIPADO — la categoría sale en prosa ═══\n'.blue,
  );

  const tracer = createTracer('sin-router-tipado');
  const categoriasValidas = Object.keys(DEPARTAMENTOS);

  // Contamos cuántas veces el modelo se sale del enum. Es una verificación
  // determinista: no le preguntamos al modelo si acertó, lo comprobamos.
  let fueraDeEnum = 0;

  for (const ticket of TICKETS) {
    const { text } = await generateText({
      model,
      prompt:
        `TICKET ${ticket.id}:\n${ticket.mensaje}\n\n` +
        `CATEGORÍAS VÁLIDAS: ${categoriasValidas.join(' | ')}`,
      instructions:
        'Eres un clasificador de tickets de soporte. Responde ÚNICAMENTE con ' +
        'una de las categorías válidas, en minúsculas, sin explicación, sin ' +
        'puntuación y sin ninguna palabra adicional.',
      onStepEnd: tracer.onStepFinish,
    });

    const respuesta = text.trim().toLowerCase();
    const esValida = categoriasValidas.includes(respuesta);

    if (!esValida) fueraDeEnum++;

    console.log(
      `  ${ticket.id} → ${esValida ? respuesta.green : `${respuesta} (fuera del enum)`.red}` +
        `  ${'confianza: —'.yellow}`,
    );
  }

  // `conConfianza: 0` no es un bug: generateText devuelve texto, no una
  // distribución de probabilidad. No hay con qué decidir un umbral.
  return { ...tracer.summary(), fueraDeEnum, conConfianza: 0 };
}

// ---------------------------------------------------------------------------
//! B) CON JEV — preguntas tipadas contra el estado del ticket
// ---------------------------------------------------------------------------

/**
 * La instancia vive aquí y no en `helpers/selected-model.ts` a propósito:
 * ese barrel se re-exporta con `export *`, así que declararla allí obligaría
 * a los patrones 01-03 a tener AI_GATEWAY_API_KEY para poder ejecutarse.
 * Además un EvaluationModel no es intercambiable con un LanguageModel.
 */
const jev = gateway.evaluationModel('typesafe-ai/jev');

/**
 * Las tres preguntas viajan en UNA sola petición contra el mismo estado.
 * Cada tipo responde algo distinto:
 *   choice  → a qué cola va          (elección dentro del enum)
 *   score   → qué tan urgente es     (posición en una rúbrica ordenada)
 *   boolean → si hay que activar el guardrail de devoluciones
 */
function evaluarTicket(ticket: Ticket) {
  return evaluate({
    model: jev,

    // El estado puede ser un objeto JSON, no solo texto: así el modelo ve
    // también el plan y la antigüedad, que pesan en la urgencia.
    state: {
      mensaje: ticket.mensaje,
      plan: ticket.plan,
      diasDesdeCompra: ticket.diasDesdeCompra,
      intentosPrevios: ticket.intentosPrevios,
    },

    questions: {
      departamento: {
        type: 'choice',
        instructions: '¿Qué equipo debe atender este ticket?',
        criteria: DEPARTAMENTOS,
      },
      severidad: {
        type: 'score',
        instructions: '¿Qué tan grave es la situación para este cliente?',
        criteria: SEVERIDAD,
      },
      pideReembolso: {
        type: 'boolean',
        instructions: '¿El cliente está pidiendo que le devuelvan su dinero?',
        criteria: {
          true: 'Pide explícitamente un reembolso, devolución o cancelar el cobro.',
          false: 'Solo reporta un problema o pide ayuda, sin exigir el dinero.',
        },
      },
    },
  });
}

/** Las respuestas ya tipadas, derivadas de la propia llamada. */
type Respuestas = Awaited<ReturnType<typeof evaluarTicket>>['answers'];

const UMBRAL_CONFIANZA = 0.6;
const UMBRAL_REEMBOLSO = 0.8;
const UMBRAL_URGENCIA = 2.5;

/**
 * El enrutamiento en sí NO usa el modelo: es una función pura sobre las
 * respuestas. Ahí está la gracia del patrón — el modelo clasifica, el código
 * decide, y los umbrales quedan a la vista y se pueden testear.
 */
function decidirDestino(answers: Respuestas) {
  const { departamento, severidad, pideReembolso } = answers;

  // Las distribuciones de choice/score son OPCIONALES en la especificación.
  // El `?? 0` deja la confianza en cero cuando no vienen, y eso manda el
  // ticket a un humano: preferimos escalar de más que enrutar mal.
  const confianza = departamento.probabilities?.[departamento.choice] ?? 0;
  const prioridad = severidad.score >= UMBRAL_URGENCIA ? 'alta' : 'normal';

  // El guardrail va PRIMERO: si exige devolución, manda sobre la clasificación.
  if (pideReembolso.probability >= UMBRAL_REEMBOLSO) {
    return { cola: 'reembolsos', prioridad, motivo: 'exige devolución' };
  }

  if (confianza < UMBRAL_CONFIANZA) {
    return { cola: 'humano', prioridad, motivo: 'confianza insuficiente' };
  }

  return { cola: departamento.choice, prioridad, motivo: 'clasificación directa' };
}

async function conJev() {
  console.log('\n═══ B) CON JEV — decisiones tipadas y con confianza ═══\n'.blue);

  let steps = 0;
  let totalTokens = 0;
  let conConfianza = 0;

  for (const ticket of TICKETS) {
    const resultado = await evaluarTicket(ticket);

    // `evaluate` no tiene pasos ni tool calls, así que createTracer no aplica:
    // la fila de la comparativa se arma a mano. `totalTokens` sólo llega
    // cuando el proveedor reporta entrada Y salida, de ahí el `?? 0`.
    steps++;
    totalTokens += resultado.usage.totalTokens ?? 0;

    const { departamento, severidad, pideReembolso } = resultado.answers;
    if (departamento.probabilities) conConfianza++;

    const confianza = departamento.probabilities?.[departamento.choice] ?? 0;
    const destino = decidirDestino(resultado.answers);

    console.log(
      `  ${ticket.id} → ${departamento.choice.green}` +
        `  ${`confianza: ${(confianza * 100).toFixed(0)}%`.yellow}` +
        `  ${`urgencia: ${severidad.score.toFixed(2)}/${SEVERIDAD.length - 1}`.purple}` +
        `  ${`reembolso: ${(pideReembolso.probability * 100).toFixed(0)}%`.blue}`,
    );
    console.log(
      `        cola: ${destino.cola.green} · prioridad: ${destino.prioridad} · ${destino.motivo}`,
    );
  }

  // fueraDeEnum es 0 por construcción: el tipo `choice` sólo puede devolver
  // una de las claves declaradas en `criteria`. No es suerte, es el contrato.
  return { steps, totalTokens, fueraDeEnum: 0, conConfianza };
}

// ---------------------------------------------------------------------------
// EJECUCIÓN DEL PROGRAMA
// ---------------------------------------------------------------------------

export async function jevMain() {
  const a = await sinRouterTipado();

  let b: Awaited<ReturnType<typeof conJev>> | undefined;

  try {
    b = await conJev();
  } catch (error) {
    // Si el Gateway falla no tumbamos el laboratorio: el baseline ya corrió
    // y sigue siendo comparable, así que informamos y seguimos.
    console.error('\n  No se pudo consultar a Jev.'.red);
    console.error(
      `  ${error instanceof Error ? error.message : String(error)}`.red,
    );
    console.error(
      '\n  Revisa que AI_GATEWAY_API_KEY esté definida en el .env y que tu\n' +
        '  cuenta de Vercel tenga un método de pago registrado: el AI Gateway\n' +
        '  lo exige incluso para consumir los créditos gratuitos.\n',
    );
  }

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    'Sin router tipado': a,
    ...(b ? { 'Con Jev': b } : {}),
  });

  console.log(
    '\n  Un LLM generalista puede clasificar, pero responde en prosa: nada\n' +
      '  garantiza que se quede dentro del enum y no hay con qué medir dudas.\n\n' +
      '  Un modelo de evaluación devuelve la elección ya dentro del contrato y\n' +
      '  su distribución de probabilidad. Eso es lo que permite poner umbrales:\n' +
      '  escalar a un humano cuando no está seguro y disparar un guardrail\n' +
      '  cuando el cliente exige su dinero.\n\n' +
      '  Jev no escribe la respuesta al cliente. Solo decide a dónde va.\n' +
      '  Clasificar y redactar son trabajos distintos, y conviene separarlos.\n',
  );
}
