/**
 * PATRÓN: Planificación - Planning
 * --------------------------------
 * El modelo descompone la tarea en pasos ANTES de ejecutar.
 *
 * Sin planificación, el modelo intenta resolver todo de una vez y pierde
 * restricciones por el camino: manda un héroe que no contrarresta el poder
 * del villano, se pasa de las horas disponibles, o captura a un villano
 * después de que otro ya haya liberado a media prisión.
 *
 * Con planificación, cada paso resuelve una sola cosa y arrastra el
 * resultado al siguiente, en 3 fases (ver `withPlanning`):
 *   1. Construir el plan   -> `buildPlan()`   (salida estructurada con Zod)
 *   2. Ejecutar paso a paso -> un `generateText` por cada paso del plan
 *   3. Sintetizar           -> un último `generateText` que junta todo
 *
 * Cada llamada al modelo es independiente (no hay memoria entre ellas), así
 * que el "estado" del agente (reglas, hallazgos previos) hay que reenviarlo
 * a mano en cada prompt.
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';

import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// LOS DATOS — el escenario
// ---------------------------------------------------------------------------

type Villain = {
  alias: string;
  power: string;
  /** Única especialidad capaz de neutralizarlo. */
  counteredBy: string;
  /** 1 = máxima prioridad. */
  threat: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /**
   * Puede liberar a los demás. NO se muestra en el texto del escenario:
   * el modelo debe deducirlo a partir del poder descrito.
   */
  freesOthers: boolean;
};

type Hero = {
  alias: string;
  specialty: string;
  /** Horas que puede operar antes de quedar fuera de combate. */
  availableHours: number;
};

const VILLAINS: Villain[] = [
  {
    alias: 'Mister Freeze',
    power: 'congela todo a su alrededor',
    counteredBy: 'fuego',
    threat: 1,
    freesOthers: false,
  },
  {
    alias: 'Killgrave',
    power: 'controla mentes con la voz',
    counteredBy: 'tecnología',
    threat: 2,
    freesOthers: false,
  },
  {
    alias: 'The Shade',
    power: 'se vuelve intangible en las sombras',
    counteredBy: 'luz',
    threat: 7,
    freesOthers: false,
  },
  {
    alias: 'Mirror Master',
    power: 'viaja por la dimensión espejo y puede sacar a otros de sus celdas',
    counteredBy: 'tecnología',
    threat: 3,
    freesOthers: true,
  },
  {
    alias: 'Solomon Grundy',
    power: 'regenera su cuerpo sin importar el daño recibido',
    counteredBy: 'luz',
    threat: 6,
    freesOthers: false,
  },
  {
    alias: 'Doctor Light',
    power: 'absorbe y redirige cualquier fuente de energía luminosa',
    counteredBy: 'luz',
    threat: 4,
    freesOthers: false,
  },
  {
    alias: 'Juggernaut',
    power: 'fuerza imparable, nada detiene su avance',
    counteredBy: 'telequinesis',
    threat: 5,
    freesOthers: false,
  },
];

const HEROES: Hero[] = [
  { alias: 'Antorcha Humana', specialty: 'fuego', availableHours: 6 },
  { alias: 'Green Lantern', specialty: 'luz', availableHours: 4 },
  { alias: 'Iron Man', specialty: 'tecnología', availableHours: 5 },
  { alias: 'Jean Grey', specialty: 'telequinesis', availableHours: 3 },
  { alias: 'Superman', specialty: 'fuego|luz', availableHours: 2 },
];

const SCENARIO_AS_TEXT = [
  'VILLANOS SUELTOS:',
  ...VILLAINS.map(
    (villain) =>
      `  ${villain.alias} | poder: ${villain.power} | ` +
      `solo lo detiene: ${villain.counteredBy} | amenaza: ${villain.threat}/7`,
  ),
  '',
  'HÉROES DISPONIBLES:',
  ...HEROES.map(
    (hero) =>
      `  ${hero.alias} | especialidad: ${hero.specialty} | ` +
      `horas disponibles: ${hero.availableHours}`,
  ),
].join('\n');

/**
 * Vista previa (solo referencia, no se ejecuta) de cómo luce
 * `SCENARIO_AS_TEXT` una vez armado, para no tener que correr el código
 * mentalmente:
 *
 * VILLANOS SUELTOS:
 *   Mister Freeze | poder: congela todo a su alrededor | solo lo detiene: fuego | amenaza: 1/7
 *   Killgrave | poder: controla mentes con la voz | solo lo detiene: tecnología | amenaza: 2/7
 *   The Shade | poder: se vuelve intangible en las sombras | solo lo detiene: luz | amenaza: 7/7
 *   Mirror Master | poder: viaja por la dimensión espejo y puede sacar a otros de sus celdas | solo lo detiene: tecnología | amenaza: 3/7
 *   Solomon Grundy | poder: regenera su cuerpo sin importar el daño recibido | solo lo detiene: luz | amenaza: 6/7
 *   Doctor Light | poder: absorbe y redirige cualquier fuente de energía luminosa | solo lo detiene: luz | amenaza: 4/7
 *   Juggernaut | poder: fuerza imparable, nada detiene su avance | solo lo detiene: telequinesis | amenaza: 5/7
 *
 * HÉROES DISPONIBLES:
 *   Antorcha Humana | especialidad: fuego | horas disponibles: 6
 *   Green Lantern | especialidad: luz | horas disponibles: 4
 *   Iron Man | especialidad: tecnología | horas disponibles: 5
 *   Jean Grey | especialidad: telequinesis | horas disponibles: 3
 */

// ---------------------------------------------------------------------------
// EL PROBLEMA
// ---------------------------------------------------------------------------

/**
 * El enunciado cruza cuatro restricciones:
 *   1. Cada villano solo cae ante una especialidad concreta.
 *   2. Cada héroe tiene un límite de horas.
 *   3. Cada operación consume 2 horas del héroe asignado.
 *   4. Mirror Master DEBE ir primero, o el resto se vuelve a escapar.
 *
 * Resolver esto "de un tirón" casi siempre rompe alguna.
 */
// NOTA: como cada llamada al modelo es independiente (sin memoria), el texto
// completo de `MISSION` (reglas incluidas) se reenvía en CADA fase (plan,
// cada paso, síntesis). Si solo se mandara una vez, el modelo "olvidaría"
// las reglas apenas avance a la siguiente llamada.
const MISSION =
  'Se han fugado 7 villanos de la prisión de máxima seguridad. ' +
  'Diseña el operativo para recapturarlos a todos.\n\n' +
  'REGLAS:\n' +
  '  - Cada operación consume 2 horas del héroe asignado.\n' +
  '  - Los héroes pueden operar en paralelo; las horas son presupuesto individual.\n' +
  '  - Un héroe solo puede neutralizar villanos de su especialidad.\n' +
  '  - Ningún héroe puede exceder sus horas disponibles.\n' +
  '  - Atiende a los villanos por prioridad, donde 1 es el más urgente.\n' +
  '  - Si algún villano puede liberar a los demás, debe caer antes que nadie.\n' +
  '  - Si el operativo no es viable con los recursos disponibles, dilo.\n\n' +
  SCENARIO_AS_TEXT;


// ---------------------------------------------------------------------------
//! A) SIN PLANIFICACIÓN — una sola llamada, todo de golpe
// ---------------------------------------------------------------------------
async function withoutPlanning() {
  console.log('\n═══ A) SIN PLANIFICACIÓN ═══\n'.blue);

  // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
  const tracer = createTracer('Sin planificación');

  // Caso de control (baseline): UNA sola llamada con la misión completa
  // (reglas + escenario), sin `tools` ni `output` estructurado. El modelo
  // tiene que leer las 6 reglas, cruzarlas con 7 villanos y 5 héroes, y
  // resolver todo de memoria en un solo intento. Sirve para comparar contra
  // `withPlanning()`.
  const { text } = await generateText({
    model,
    prompt: MISSION,
    onStepEnd: tracer.onStepFinish,
  });


  console.log('\n Respuestas:', text.green)

  // No hay validación automática: esta checklist es la que hay que revisar
  // A MANO contra la respuesta del modelo para detectar restricciones rotas.
  console.log(
    (
      '\n  ⚠️  Verifica: ¿va Mirror Master primero?' +
      '\n      ¿cada héroe contrarresta de verdad el poder asignado?' +
      '\n      ¿son atrapados en orden de amenaza?' +
      '\n      ¿alguien supera sus horas disponibles?'
    ).yellow,
  );

  return tracer.summary();

}


// ---------------------------------------------------------------------------
//! B) CON PLANIFICACIÓN — primero el plan, luego la ejecución
// ---------------------------------------------------------------------------

// Esquema de Zod que describe la forma EXACTA que debe tener el plan.
// Se envuelve en un objeto (`{ steps: [...] }`) y no se deja como un array
// suelto porque así es más fácil de extender a futuro (ej. agregar
// `estimatedHours` o `risk` al nivel del plan) sin romper el contrato.
const planSchema = z.object({
  // El plan es un arreglo de pasos ORDENADOS: el índice en el arreglo ES el
  // orden de ejecución (por eso luego se itera con un `for...of`).
  steps: z.array(
    z.object({
      goal: z.string().describe('Qué resuelve este paso, en una frase'),
      // Pedirle el "reason" no es decorativo: obliga al modelo a justificar
      // el orden (ej. "va primero porque libera a los demás si no cae ya"),
      // lo cual reduce que arme una secuencia arbitraria.
      reason: z
        .string()
        .describe('¿Por qué es necesario? y ¿Por qué va en esta posición?'),
    }),
  )
    .min(2) // Un mínimo de 2 pasos: con 1 solo paso no hay nada que planificar.
    .max(15) // Techo defensivo: evita un plan desproporcionado en pasos (y por lo tanto en llamadas/tokens de la Fase 2).
    .describe('Pasos ordenados. Cada paso resuelve UNA sola cosa'),
});



// Fase 1: el modelo actúa como "estratega", NO como ejecutor. Su única
// tarea es descomponer la misión en pasos ordenados (sin resolver nada
// todavía). En vez de pedir `text` libre (que habría que parsear a mano y
// que puede venir con formato inconsistente), se usa `output: Output.object`
// para forzar que la respuesta sea un JSON que cumple `planSchema` al pie de
// la letra. Eso permite iterar `output.steps` con un `for...of` normal en
// la Fase 2, sin parsear texto.
async function buildPlan( tracer: ReturnType<typeof createTracer> ) {

  const { output } = await generateText({
    model,
    output: Output.object({
      schema: planSchema,
    }),
    prompt: MISSION,
    instructions: // El "system prompt": le da identidad y una regla clave (no adelantarse)
      'Eres un estratega. NO resuelvas el operativo todavia. ' +
      'Responde en español. ' +
      'Solo decomponlo en pasos ordenados, donde cada paso dependa ' +
      'del resultado del anterior.',
    onStepEnd: tracer.onStepFinish,
  });

  return output.steps;

}

async function withPlanning() {

  console.log('==== B) Con planificación ======='.blue);

  // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
  const tracer = createTracer('con-planificación');


  //* Fase 1: Construir el plan.
  // El agente todavía no resuelve nada: solo descompone la misión en pasos
  // ordenados (ver `buildPlan`).
  const steps = await buildPlan(tracer);
  console.log('Steps:'.red, steps);


  //* Fase 2: Ejecutar paso a paso.
  // Un `generateText` POR CADA paso del plan. Como cada llamada es
  // independiente (sin memoria), `findings` actúa como la memoria a corto
  // plazo del agente: en cada iteración se le reenvía todo lo resuelto
  // hasta ahora, para que no repita ni contradiga pasos anteriores.
  const findings: string[] = [];

  for ( const [index, step] of steps.entries() ) {
    console.log(`\n --> Ejecutando paso ${ index + 1 }: ${ step.goal }`.blue);

    const { text } = await generateText({
      model,
      instructions: // Freno explícito: sin esto, el modelo tiende a "adelantarse" y resolver el operativo completo de una vez, anulando el propósito de ir paso a paso.
        'Resuelve únicamente el paso indicado. ' +
        'No te adelantes a los siguientes pasos ni des el operativo final. ',
      // El "Paso actual" se manda SIEMPRE (no solo en el primer paso); lo
      // que cambia entre iteraciones es si ya hay `findings` previos que
      // agregar como contexto adicional.
      prompt:
        `Misión original: ${ MISSION } \n\n` +
        ( findings.length
          ? `Resuelto hasta ahora: ${ findings.join('\n----\n') }\n\n`
          : '' ) +
        `Paso actual: ${ step.goal }`,
      onStepEnd: tracer.onStepFinish,
    });

    findings.push(`[ ${ step.goal } ]\n ${ text.trim() }`);

  }

  console.log({ findings });

  //* Fase 3: Sintetizar.
  // Durante la Fase 2 el modelo resolvió "a ciegas", un paso a la vez, sin
  // ver el panorama completo. Aquí se le pasan TODOS los `findings` juntos
  // para que arme un operativo final coherente (y no una simple concatenación
  // de respuestas parciales).
  const { text: finalPlan } = await generateText({
    model,
    instructions:
      'Integra los resultados parciales en operativo final.' +
      'Se concreto: Orden de intervención y de prioridades. ',
    prompt:
      `MISIÖN: \n${MISSION} \n\n` +
      `RESULTADOS PARCIALES: \n ${ findings.join('\n---\n') }`,
    onStepEnd: tracer.onStepFinish,
  });

  // Este es el resultado final del patrón: el "operativo" que se compara
  // contra la respuesta one-shot de `withoutPlanning()`.
  console.log('\n\nOperativo final:', finalPlan);

  // Para verificar la cantidad de tokens y poder hacer la comparativa
  return tracer.summary();


}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
// Punto de entrada del patrón: ejecuta el caso "con planificación" y muestra
// un resumen (pasos ejecutados + tokens totales). El caso `withoutPlanning`
// queda comentado para no ejecutarlo por defecto; descomenta ambas líneas
// (y la fila del `console.table`) para comparar el resultado one-shot contra
// el planificado con la misma misión.
export async function planningMain() {
  //const a = await withoutPlanning();
  const b = await withPlanning();

  console.log('\n═══ COMPARATIVA ═══\n'.blue);
  console.table({
    // 'Sin planificación': a,
     'Con planificación': b,
  });
  

  console.log(
    '\n  Planificar cuesta más llamadas y más tokens.\n' +
      '  Lo que compra es que las restricciones sobrevivan hasta el final.\n' +
      '  Si no hay restricciones que perder, no compra nada.\n',
  );
}