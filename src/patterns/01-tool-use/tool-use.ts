/**
 * PATRÓN: Uso de herramientas - Tool use
 * ---------------------------
 * El catálogo de cursos NO está en el entrenamiento
 * del modelo. Sin herramientas, el modelo inventa precios y cursos con
 * total confianza o en su defecto, no hace nada.
 * Con herramientas, consulta el dato real.
 */

import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
//  LA "BASE DE DATOS" — datos que el modelo no puede conocer
// ---------------------------------------------------------------------------

type Course = {
  id: string;
  title: string;
  hours: number;
  priceUSD: number;
  level: 'basic' | 'intermediate' | 'advanced';
  students: number;
};

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
const QUESTION = `¿Cuánto costaria juntos el curso de TypeScript y el de Docker con un 20% de descuento?
                Dame tambien las horas totales.`



async function withoutTools() {

    // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
    const tracer = createTracer('sin-herramientas')

    const { text } = await generateText({
        model: model,
        prompt: QUESTION,
        onStepEnd: tracer.onStepFinish    // Cuando se termina el paso usa el tracer
    });

    console.log('\n Respuesta: ', text.green);
    console.warn('\n Verificar los números contra el catalogo de cursos');

    return tracer.summary();

}


//! ========= Aqui implementamos el patón TOOL USE

// Tool #1 find courses (herramienta que sirve para buscar nuestros cursos)
const findCourses = tool({

    //! Definimos la herramienta
    description: 
        'Buscar cursos en el catálogo de DevTalles, por texto, ' +
        'por titulo o por nivel. Utilizala siempre antes de responder' +
        'cualquier pregunta sobre cursos, precios, cantidad de alumnos. ',

    inputSchema: z.object({
        text: z   // z es una validador de esquema: se asegura que el objeto que recibe lusca de la manera como se le pide
            .string()
            .optional()
            .describe('Texto a buscar en el titulo del curso.'),
        level: z.enum(['basic' , 'intermediate' , 'advanced']).optional(),
    }), // inputSchema es necesario para indicarle al modelo la información que esta esperando y el tipo de dato que sirve

    //! el execute es los que hace realmente la herramienta
    execute: async ({ text, level }) => {
        const filteredCourses = COURSE_CATALOG.filter( (courses) => {
            const matchesText = !text || courses.title.toLowerCase().includes( text.toLowerCase() );
            const matchesLevel = !level || courses.level === level;

            return matchesText && matchesLevel;
        });

        return {
            found: filteredCourses.length,
            courses: filteredCourses,
        }
    }

});


// Tool #2
const calculateTotal = tool({

    //! Definimos la herramienta
    description:
        'Calcula el precio total de una lista de cursos aplicando un descuento porcentual. ' +
        'Utiliza siempre para cualquier operación aritmetica: no calcules mentalmente.',

    inputSchema: z.object({
        ids: z.array(z.string()).describe('IDs de los cursos. ej: ["ts-01","dkr-0523"]'),        // Es un arreglo de string
        discountPercent: z.number().min(0).max(100).default(0),
    }),

    //! el execute es los que hace realmente la herramienta
    execute: async({ ids, discountPercent }) => {

        const foundCourses = COURSE_CATALOG.filter( (course) => 
            ids.includes(course.id)
        );


        const notFound = ids.filter(
            (id) => !COURSE_CATALOG.some( (course) => course.id === id )
        );


        const subtotal = foundCourses.reduce(
            (acc, course) => acc + course.priceUSD,
            0
        );

        const discount = subtotal * ( discountPercent / 100 );

        // console.log('Hola mundo; subtotal'.purple, Number(subtotal.toFixed(2)));

        return {
            subtotal: Number( subtotal.toFixed(2) ),
            discount: Number( discount.toFixed(2) ),
            total: Number( subtotal -  discount ).toFixed(2),
            notFound: notFound
        };

    },


});


async function withTools() {

    // Invocamos el tracer para saber que es lo que esta haciendo la IA (el tren de pensamiento)
    const tracer = createTracer('con-herramientas')

    const { text } = await generateText({
        model: model,
        prompt: QUESTION,  // Este prompt corresponde a las consulta del usuario
        tools: {
            findCourses,
            calculateTotal,
        },
        //! Patrón Circuit Breaker
        stopWhen: stepCountIs(6),  // Hasta la sexta iteración se sale
        instructions: // Esta son las instrucciones que le van a dar la memoria a nuestro agente de quien es
            'Eres un asistente del catálogo de cursos de DevTalles.' +
            'No inventes precios, duración ni nombres de cursos.' +
            'Consúltalos siempre con las herramientas disponibles.',
        onStepEnd: tracer.onStepFinish    // Cuando se termina el paso usa el tracer
    });

    console.log('\n Respuesta: ', text.green);
    console.warn('\n Verificar los números contra el catalogo de cursos');

    return tracer.summary();

}

export async function toolUseMain() {

    //const resultA = await withoutTools();
    const resultB = await withTools();


    console.log('\n ===== Comparativa =====');
    console.table({
        //'Sin herramientas': resultA,
        'Con herramientas': resultB
    })

}



