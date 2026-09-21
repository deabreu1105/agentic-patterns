
1. ¿Cuál es el propósito principal de implementar el patrón "Tool Use" en un modelo de inteligencia artificial?
R, Para evitar alucinaciones dándole al modelo acceso a información externa y real con la que no fue entrenado.
Los modelos de IA no conocen información privada o específica de tu negocio. Al darles herramientas, evitas 
que inventen datos y les permites buscar respuestas precisas.

2. Al definir una herramienta, ¿por qué es crucial utilizar un validador de esquemas (como Zod) para crear el inputSchema?
R, Para garantizar que el modelo envíe los parámetros exactamente con la estructura y el tipo de dato que la herramienta necesita.
El esquema le indica al modelo exactamente qué datos debe proveer (por ejemplo, un arreglo de strings) y valida que no envíe

3. ¿Cuál es la función del patrón "Circuit Breaker" (ejemplificado al usar la condición stopWhen: stepCountIs(...)) dentro del flujo de un agente?
R, Prevenir que el modelo entre en un bucle infinito de llamadas a herramientas si se queda atascado sin hallar la solución.
herramienta falla repetidamente o el modelo no entiende cómo usarla, este patrón actúa como un "cortacircuitos" limitando el máximo de iteraciones permitidas, ahorrando tokens y evitando bloqueos.

4. Si ocurre un error lógico durante la ejecución de una herramienta (por ejemplo, no se encuentra un curso en la base de datos), ¿cuál es la forma correcta de manejarlo según el patrón enseñado?
R, Retornar el estado del error como parte del objeto de respuesta de la herramienta para que el modelo decida qué hacer.
Al devolver una bandera o mensaje de error (como un valor notFound), el modelo recibe contexto sobre la falla y puede reformular su respuesta, disculparse, o intentar otra estrategia.

5. Al diseñar la respuesta de una herramienta (lo que retorna el método execute), ¿por qué se recomienda encarecidamente devolver un objeto en lugar de un valor primitivo (como un simple número o string)?
R, Porque los objetos son mucho más fáciles de expandir en el futuro añadiendo nuevas propiedades sin romper la lógica del modelo.
Si hoy tu herramienta devuelve la cantidad de cursos ({ length: 5 }), mañana puedes agregar fácilmente la lista de cursos ({ length: 5, courses: [...] }) sin que el modelo pierda el contexto original, facilitando la escalabilidad.

6. ¿Por qué es beneficioso delegar operaciones matemáticas (como calcular el subtotal y descuentos) a una herramienta específica en lugar de dejar que el modelo las deduzca?
R, Porque los modelos pueden alucinar en cálculos o ignorar reglas de negocio específicas, mientras que el código garantiza precisión programática.
Aunque los modelos LLM han mejorado en razonamiento, siguen siendo propensos a errores aritméticos simples o a desconocer reglas de negocio (como límites máximos de descuento). Una herramienta traslada el cálculo a un entorno determinista y 100% confiable.

7. ¿Cuál es la principal ventaja de utilizar un "tracer" (rastreador) durante el desarrollo de agentes con múltiples herramientas?
R, Permite al desarrollador auditar visualmente el consumo de tokens, los pasos ejecutados y el tren de pensamiento interno del modelo.
El tracer es invaluable en el desarrollo porque transparenta la "caja negra" del agente, permitiéndote ver por qué tomó ciertas decisiones, qué herramientas invocó y cuánto coste en tokens representó cada acción.