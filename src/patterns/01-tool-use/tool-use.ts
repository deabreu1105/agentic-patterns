/**
 * PATRÓN: Uso de herramientas - Tool use
 * ---------------------------
 * El catálogo de cursos NO está en el entrenamiento
 * del modelo. Sin herramientas, el modelo inventa precios y cursos con
 * total confianza o en su defecto, no hace nada.
 * Con herramientas, consulta el dato real.
 */

// generateText: hace UNA (o varias, si hay tools) llamadas al modelo y espera el texto completo (no streaming).
// tool: helper de Vercel AI SDK para declarar una herramienta (nombre implícito por la key, description, inputSchema, execute).
// stepCountIs: helper que crea la condición de parada `stopWhen` basada en número de pasos (ver más abajo, patrón Circuit Breaker).
import { generateText, tool, stepCountIs } from 'ai';
// zod: librería de validación/definición de esquemas. Aquí se usa para describirle al modelo
// qué forma deben tener los argumentos de cada herramienta (tipos + descripciones en lenguaje natural).
import { z } from 'zod';
// createTracer: helper propio del proyecto para loguear paso a paso lo que hace el agente (tool calls, resultados, tokens).
// model: instancia del modelo de lenguaje ya configurado (provider + modelId) que se reutiliza en todo el patrón.
import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
//  LA "BASE DE DATOS" — datos que el modelo no puede conocer
// ---------------------------------------------------------------------------

// Tipo TypeScript que describe la forma de un curso. Sirve como contrato tanto
// para el catálogo como para lo que cada herramienta recibe/devuelve.
type Course = {
  id: string;                                      // identificador único del curso (lo usa calculateTotal para buscarlo)
  title: string;                                    // nombre visible del curso
  hours: number;                                    // duración total en horas
  priceUSD: number;                                 // precio en dólares
  level: 'basic' | 'intermediate' | 'advanced';     // nivel del curso (union type, no cualquier string)
  students: number;                                 // cantidad de alumnos inscritos
};

// Catálogo "real" de cursos, simulando una base de datos o API interna.
// Este dato es intencionalmente privado/reciente: el modelo NUNCA lo vio en
// su entrenamiento, por lo que sin herramientas solo puede inventarlo.
const COURSE_CATALOG: Course[] = [
  {
    id: 'ts-01',
    title: 'TypeScript desde cero',
    hours: 22,
    priceUSD: 19.99,
    level: 'basic',
    students: 48_120,
  },
  {
    id: 'nest-02',
    title: 'NestJS: API REST modular',
    hours: 31,
    priceUSD: 24.99,
    level: 'intermediate',
    students: 22_450,
  },
  {
    id: 'flu-03',
    title: 'Flutter: apps multiplataforma',
    hours: 46,
    priceUSD: 29.99,
    level: 'intermediate',
    students: 61_300,
  },
  {
    id: 'agt-04',
    title: 'Agentes de IA con TypeScript',
    hours: 18,
    priceUSD: 34.99,
    level: 'advanced',
    students: 1_890,
  },
  {
    id: 'dkr-05',
    title: 'Docker para desarrolladores',
    hours: 14,
    priceUSD: 17.99,
    level: 'basic',
    students: 35_770,
  },
];

// Al enviar este prompt lo mas probable es que aunque estemos utilizando el modelo mas fuerte del mercado no va a responder apropiadamente
// Ya que no hay contexto
// Requiere: buscar 2 cursos por nombre, sumar precios, aplicar descuento y sumar horas.
// Nada de eso está en el prompt como dato — el modelo tendría que "saberlo" o inventarlo.
const QUESTION = `¿Cuánto costaria juntos el curso de TypeScript y el de Docker con un 20% de descuento?
                Dame tambien las horas totales.`


// Caso de control (baseline): se le hace la pregunta al modelo SIN darle
// acceso al catálogo ni a una calculadora. Sirve para comparar contra `withTools`.
async function withoutTools() {

    // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
    const tracer = createTracer('sin-herramientas')

    // Llamada simple al modelo: un solo prompt, sin tools, por lo que solo habrá 1 "step".
    const { text } = await generateText({
        model: model,
        prompt: QUESTION,
        onStepEnd: tracer.onStepFinish    // Cuando se termina el paso usa el tracer
    });

    console.log('\n Respuesta: ', text.green);
    // Advertencia intencional: sin herramientas el modelo puede alucinar precios/horas,
    // por eso hay que verificar manualmente contra el catálogo real.
    console.warn('\n Verificar los números contra el catalogo de cursos');

    return tracer.summary();

}


//! ========= Aqui implementamos el patón TOOL USE

// Tool #1 find courses (herramienta que sirve para buscar nuestros cursos)
const findCourses = tool({

    //! Definimos la herramienta
    // La `description` NO es un comentario para humanos: es el texto que el
    // modelo lee para decidir CUÁNDO y PARA QUÉ usar esta herramienta.
    // Por eso es explícita ("Utilizala siempre antes de responder...").
    description:
        'Buscar cursos en el catálogo de DevTalles, por texto, ' +
        'por titulo o por nivel. Utilizala siempre antes de responder' +
        'cualquier pregunta sobre cursos, precios, cantidad de alumnos. ',

    // inputSchema es necesario para indicarle al modelo la información que esta esperando y el tipo de dato que sirve.
    // El modelo genera un JSON que Zod valida en runtime antes de ejecutar `execute`;
    // si el modelo manda algo con forma inválida, la llamada falla antes de tocar nuestro código.
    inputSchema: z.object({
        text: z   // z es un validador de esquema: se asegura que el objeto que recibe luzca de la manera como se le pide
            .string()
            .optional()                                      // el modelo puede omitirlo (ej: buscar solo por nivel)
            .describe('Texto a buscar en el titulo del curso.'), // descripción en lenguaje natural: guía al modelo sobre qué mandar aquí
        level: z.enum(['basic' , 'intermediate' , 'advanced']).optional(), // también opcional; solo 3 valores válidos
    }),

    //! el execute es los que hace realmente la herramienta
    // Recibe ya los argumentos tipados y validados por Zod (text, level).
    execute: async ({ text, level }) => {
        const filteredCourses = COURSE_CATALOG.filter( (courses) => {
            // Si no se mandó `text`, no filtra por texto (todo pasa). Si se mandó,
            // compara en minúsculas para que la búsqueda no sea sensible a mayúsculas.
            const matchesText = !text || courses.title.toLowerCase().includes( text.toLowerCase() );
            // Mismo criterio para `level`: si no viene, no filtra por nivel.
            const matchesLevel = !level || courses.level === level;

            return matchesText && matchesLevel;
        });

        // Se devuelve un OBJETO (no un array plano ni un primitivo). Esto es a
        // propósito: es más fácil de extender a futuro (ej. agregar `page`,
        // `totalInCatalog`, etc.) sin romper el contrato con el modelo.
        return {
            found: filteredCourses.length, // cantidad de resultados: le da contexto rápido al modelo (ej. "no encontré nada")
            courses: filteredCourses,      // los cursos encontrados, con todos sus campos
        }
    }

});


// Tool #2 Calcular total de cursos aplicando descuento
const calculateTotal = tool({

    //! Definimos la herramienta
    // Instrucción explícita ("no calcules mentalmente") para evitar que el modelo
    // haga la aritmética por su cuenta y alucine el resultado: se lo delegamos
    // a código determinista.
    description:
        'Calcula el precio total de una lista de cursos aplicando un descuento porcentual. ' +
        'Utiliza siempre para cualquier operación aritmetica: no calcules mentalmente.',

    inputSchema: z.object({
        ids: z.array(z.string()).describe('IDs de los cursos. ej: ["ts-01","dkr-0523"]'),        // Es un arreglo de string
        // min/max acotan el rango válido (0-100%); default(0) permite omitir el descuento
        // sin que Zod falle (el modelo no está obligado a mandarlo).
        discountPercent: z.number().min(0).max(100).default(0),
    }),

    //! el execute es los que hace realmente la herramienta
    execute: async({ ids, discountPercent }) => {

        // Cursos del catálogo cuyo id está en la lista pedida por el modelo.
        const foundCourses = COURSE_CATALOG.filter( (course) =>
            ids.includes(course.id)
        );

        // IDs que el modelo mandó pero que NO existen en el catálogo (ej. un id inventado
        // o mal escrito). Se reportan en la respuesta en vez de lanzar un error: así el
        // modelo puede avisarle al usuario o corregir su siguiente llamada.
        const notFound = ids.filter(
            (id) => !COURSE_CATALOG.some( (course) => course.id === id )
        );

        // Suma de precios de los cursos encontrados (reduce con acumulador inicial 0).
        const subtotal = foundCourses.reduce(
            (acc, course) => acc + course.priceUSD,
            0
        );

        const discount = subtotal * ( discountPercent / 100 );

        // BUG corregido: antes se hacía Number(subtotal - discount).toFixed(2),
        // lo que devolvía un STRING (toFixed siempre retorna string) mientras
        // que subtotal y discount son number. Esa inconsistencia de tipos podía
        // confundir al modelo al comparar/operar con el resultado.
        // La forma correcta es redondear primero y convertir a Number después.
        return {
            subtotal: Number( subtotal.toFixed(2) ),
            discount: Number( discount.toFixed(2) ),
            total: Number( (subtotal - discount).toFixed(2) ),
            notFound: notFound
        };

    },


});


// Caso con el patrón aplicado: se le da al modelo las herramientas `findCourses`
// y `calculateTotal`. El modelo decide por sí solo cuándo y con qué argumentos
// llamarlas (esto puede tomar varios "steps": pensar → llamar tool → leer
// resultado → llamar otra tool → responder texto final).
async function withTools() {

    // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
    const tracer = createTracer('con-herramientas')

    const { text } = await generateText({
        model: model,
        prompt: QUESTION,  // Este prompt corresponde a las consulta del usuario
        tools: {
            findCourses,     // se registran con el nombre de la key (el modelo las ve como "findCourses" / "calculateTotal")
            calculateTotal,
        },
        //! Patrón Circuit Breaker
        // Sin este límite, un modelo que no logra resolver la tarea (o una tool
        // que falla) podría quedar llamando herramientas indefinidamente,
        // gastando tokens y tiempo sin llegar nunca a una respuesta final.
        stopWhen: stepCountIs(6),  // Hasta la sexta iteración se sale
        instructions: // Esta son las instrucciones que le van a dar la memoria a nuestro agente de quien es
            'Eres un asistente del catálogo de cursos de DevTalles.' +
            'No inventes precios, duración ni nombres de cursos.' +
            'Consúltalos siempre con las herramientas disponibles.',
        onStepEnd: tracer.onStepFinish    // Cuando se termina el paso usa el tracer
    });

    console.log('\n Respuesta: ', text.green);
    // Se deja la advertencia por consistencia con `withoutTools`, pero aquí el
    // riesgo de alucinación es mucho menor porque los números vienen de las tools.
    console.warn('\n Verificar los números contra el catalogo de cursos');

    return tracer.summary();

}

// Punto de entrada del patrón: ejecuta el caso "con herramientas" y muestra
// un resumen (pasos ejecutados + tokens totales) en una tabla por consola.
// El caso `withoutTools` queda comentado para no ejecutarlo por defecto, pero
// se puede descomentar junto con la fila del console.table para comparar
// ambos escenarios lado a lado (alucinación vs. dato real).
export async function toolUseMain() {

    //const resultA = await withoutTools();
    const resultB = await withTools();


    console.log('\n ===== Comparativa =====');
    console.table({
        //'Sin herramientas': resultA,
        'Con herramientas': resultB
    })

}



