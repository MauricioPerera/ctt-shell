# Contrato: CTT-Shell

> **Version**: 1.0
> **Fecha**: 2026-03-16
> **Estado**: Draft
> **Autor**: MauricioPerera
> **Nombre del proyecto**: `ctt-shell`
> **Repositorio**: `MauricioPerera/ctt-shell`

## Nombre Final: `ctt-shell`

**Razonamiento**: "agent-shell-ctt" suena a un addon de Agent-Shell. El nombre `ctt-shell` pone CTT (Context-Time Training) como protagonista y shell como mecanismo de interaccion. Comunica la tesis central: contexto estructurado + ejecucion confiable = modelos pequenos que rinden como grandes. Alternativas descartadas: `ctt-agent` (generico), `shell-ctt` (suena a terminal), `contextual-shell` (largo).

## Resumen Ejecutivo

Framework TypeScript para construir agentes autonomos especializados en dominios arbitrarios (n8n, WordPress, APIs, CLIs). Combina el motor de ejecucion de Agent-Shell (registry, parser, pipelines, MCP, RBAC), la memoria persistente de CTT/RepoMemory v2 (Knowledge, Skills, Memories, Profiles con store content-addressable), y los guard rails probados en n8n-a2e/wp-a2e (normalizacion de respuestas, normalizacion de planes, circuit breaker, inline retry con feedback, aprendizaje automatico de patrones).

El resultado: un LLM de 1-3B parametros, con el contexto CTT adecuado, ejecuta tareas de dominio con la misma confiabilidad que un modelo de 12B+ sin contexto.

---

## 1. Que debe hacer (MUST DO)

### 1.1 Objetivo Principal

Proveer un framework donde registrar un "dominio" (conjunto de Knowledge entities + executor adapter) sea suficiente para que un agente LLM pueda descubrir, planificar, ejecutar y aprender dentro de ese dominio, con guard rails que compensan las limitaciones de modelos pequenos.

### 1.2 Arquitectura por Capas

```
+------------------------------------------------------------------+
|                        MCP Interface                              |
|  stdio (local) | HTTP/SSE (remoto) | CLI (dev/test)              |
+------------------------------------------------------------------+
|                        Agent Layer                                |
|  Autonomous Agent | Interactive Agent | Eval Runner               |
+------------------------------------------------------------------+
|                        Guard Rails                                |
|  Response Normalizer | Plan Normalizer | Circuit Breaker          |
|  Inline Retry | Secret Sanitizer                                  |
+------------------------------------------------------------------+
|                        Domain Layer                               |
|  Domain Registry | Knowledge Resolver | Executor Adapter          |
+------------------------------------------------------------------+
|                        CTT Memory                                 |
|  Store (SHA-256) | Search (TF-IDF) | Skills Lifecycle            |
|  Knowledge | Skills | Memories | Profiles                        |
+------------------------------------------------------------------+
|                        Shell Engine (Agent-Shell)                  |
|  Command Registry | Parser (AST) | Executor | Pipelines           |
|  RBAC | Audit | Context Store | Vector Index | JQ Filter          |
+------------------------------------------------------------------+
```

### 1.3 Funcionalidades Requeridas

#### 1.3.1 Shell Engine (reutilizacion directa de Agent-Shell)

- [ ] Command Registry con versionado semver
- [ ] Parser AST: single, pipeline (`>>`), batch (`batch [...]`)
- [ ] Executor con timeout, validacion, undo, dry-run, confirm
- [ ] Context Store (sesion, history, undo snapshots)
- [ ] JQ Filter para extraccion de campos del output
- [ ] RBAC con wildcards y roles
- [ ] Audit Logger
- [ ] Secret Detection (en inputs de comandos)
- [ ] Fluent Command Builder (API para registrar comandos)
- [ ] MCP Server (stdio + HTTP/SSE) exponiendo exactamente 2 tools:
  - `cli_help()` -- Protocolo de interaccion (~600 tokens)
  - `cli_exec(cmd)` -- Ejecuta cualquier comando registrado

**Fuente**: `agent-shell/src/` -- se reutiliza integramente.

#### 1.3.2 CTT Memory (reutilizacion adaptada de n8n-a2e)

- [ ] Store content-addressable con SHA-256 dedup
  - **Fuente**: `n8n-a2e/src/storage/store.ts`
  - **Adaptacion**: Generalizar `EntityType` para que no sea especifico de n8n. Las colecciones se definen por dominio.
- [ ] Search Engine TF-IDF con Porter stemming
  - **Fuente**: `n8n-a2e/src/search/tfidf.ts`
  - **Adaptacion**: Las expansiones de query (`EXPANSIONS`) deben ser inyectables por dominio, no hardcodeadas para n8n.
- [ ] Entidades genericas (ver seccion 1.5)
- [ ] Skills lifecycle: experimental (0-4 exitos) -> proven (5+ exitos) -> deprecated (5+ fallos)
  - **Fuente**: `n8n-a2e/src/autonomous/workflow-skills.ts`

#### 1.3.3 Guard Rails (reutilizacion adaptada de n8n-a2e)

- [ ] Response Normalizer: strip thinking tags, extraer JSON de code fences, fix trailing commas, fix single quotes, unquoted keys, auto-close brackets truncados, seleccion del mejor JSON entre multiples bloques
  - **Fuente**: `n8n-a2e/src/autonomous/normalize.ts`
  - **Adaptacion**: Ninguna necesaria, ya es generico.
- [ ] Plan Normalizer: indices out-of-bounds, self-loops, duplicados, auto-chain de nodos huerfanos, reindexacion
  - **Fuente**: `n8n-a2e/src/autonomous/normalize-plan.ts`
  - **Adaptacion**: Generalizar de `WorkflowPlan` a `ExecutionPlan` generico (steps + connections).
- [ ] Circuit Breaker: bloquear operaciones/nodos tras N fallos consecutivos, inyectar anti-patterns como contexto al LLM, tracking de razones y resoluciones
  - **Fuente**: `n8n-a2e/src/autonomous/circuit-breaker.ts`
  - **Adaptacion**: Renombrar de `n8nType` a `operationId` generico.
- [ ] Inline Retry con Feedback: cuando el LLM falla en generar JSON valido o el plan falla validacion, alimentar el error de vuelta al LLM en la misma conversacion (hasta `maxRetries` intentos)
  - **Fuente**: `n8n-a2e/src/autonomous/autonomous-agent.ts` (metodo `generatePlan` y `fixPlan`)
- [ ] Secret Sanitizer: 4 capas (known secrets, URL params, JSON fields, prefix detection)
  - **Fuente**: `n8n-a2e/src/autonomous/sanitize.ts`
  - **Adaptacion**: Ninguna necesaria, ya es generico.

#### 1.3.4 Domain Layer (nuevo)

- [ ] `DomainRegistry` -- registro de dominios con su configuracion
- [ ] `DomainAdapter` -- interfaz que cada dominio implementa:
  ```typescript
  interface DomainAdapter {
    /** Identificador unico del dominio */
    readonly id: string;
    /** Nombre legible */
    readonly name: string;
    /** Cargar Knowledge entities desde la fuente */
    extractKnowledge(): Promise<Knowledge[]>;
    /** Ejecutar una accion planificada */
    execute(plan: ExecutionPlan): Promise<ExecutionResult>;
    /** Validar un plan antes de ejecutar */
    validate(plan: ExecutionPlan): ValidationResult;
    /** Expansiones de query especificas del dominio (para TF-IDF) */
    queryExpansions?(): Record<string, string[]>;
    /** Normalizers especificos del dominio (opcional) */
    planNormalizers?(): PlanNormalizer[];
  }
  ```
- [ ] Registro de dominios via API fluent:
  ```typescript
  cttShell
    .domain('n8n')
    .adapter(new N8nAdapter({ baseUrl, apiKey }))
    .register();
  ```
- [ ] Multi-dominio simultaneo: un agente puede operar sobre n8n + WordPress + APIs custom en la misma sesion

#### 1.3.5 Agent Layer (nuevo, combinando logica de ambos)

- [ ] `AutonomousAgent` -- pipeline completo:
  1. **RECALL**: TF-IDF busca Knowledge + Skills + Memories relevantes al goal
  2. **PLAN**: LLM genera `ExecutionPlan` JSON con contexto CTT enriquecido (few-shot de Skills exitosos + anti-patterns del Circuit Breaker)
  3. **NORMALIZE**: Response Normalizer + Plan Normalizer
  4. **VALIDATE**: DomainAdapter.validate()
  5. **EXECUTE**: DomainAdapter.execute()
  6. **LEARN**: Exito -> save Skill (experimental). Fallo -> save Memory (error) + Circuit Breaker update
- [ ] `InteractiveAgent` -- mismo pipeline con confirmacion humana entre pasos
- [ ] Eventos observables: cada fase emite `AgentEvent` con fase, mensaje, data

#### 1.3.6 Eval Framework (core, no addon)

- [ ] `EvalGoal` -- goal tipado con tags, complejidad esperada, criterios
  - **Fuente**: `n8n-a2e/src/eval/evaluator.ts`
- [ ] `ModelEvaluator` -- ejecuta goals contra multiples providers LLM
- [ ] Metricas: JSON validity rate, plan validity rate, validation pass rate, deploy/exec ready rate, latencia, tokens, normalize fixes
- [ ] `runWithFeedback` -- A/B test: baseline vs con feedback de errores previos
- [ ] Soporte multi-provider: Claude, OpenAI, Ollama, Cloudflare Workers AI
- [ ] Deteccion automatica de Qwen (deshabilitar thinking mode con /no_think)
- [ ] Goals por dominio: cada DomainAdapter puede contribuir goals de evaluacion

#### 1.3.7 Interfaz MCP

- [ ] MCP Server con las 2 tools de Agent-Shell (`cli_help`, `cli_exec`)
- [ ] Los comandos CTT se registran como comandos del shell:
  - `ctt:search <query>` -- Busqueda TF-IDF en Knowledge + Skills + Memories
  - `ctt:recall <goal>` -- Recall completo (Knowledge + Skills + anti-patterns)
  - `ctt:plan <goal>` -- Generar ExecutionPlan para un goal
  - `ctt:exec <goal>` -- Pipeline autonomo completo (recall -> plan -> exec -> learn)
  - `ctt:learn <result>` -- Registrar un resultado manualmente
  - `ctt:status` -- Estado del store, circuit breakers, skills
  - `ctt:eval <goals-file>` -- Ejecutar evaluacion
  - `<domain>:*` -- Comandos especificos del dominio (registrados por el adapter)
- [ ] Transporte: stdio (MCP nativo) + HTTP/SSE (web/multi-agente)

### 1.4 Flujo Principal (Happy Path)

```
LLM                          ctt-shell                           Domain
 |                               |                                  |
 |-- cli_help() --------------->|                                  |
 |<-- protocolo interaccion ----|                                  |
 |                               |                                  |
 |-- cli_exec("ctt:search       |                                  |
 |    send email on schedule")-->|                                  |
 |                               |-- TF-IDF search --------------->|
 |                               |<-- Knowledge matches -----------|
 |<-- resultados relevantes ----|                                  |
 |                               |                                  |
 |-- cli_exec("ctt:exec         |                                  |
 |    send weekly report         |                                  |
 |    email") ----------------->|                                  |
 |                               |-- 1. RECALL: search store ----->|
 |                               |<-- context (nodes+skills+anti) -|
 |                               |-- 2. PLAN: LLM generates ------>|
 |                               |   (con few-shot + anti-patterns) |
 |                               |-- 3. NORMALIZE: fix plan ------>|
 |                               |-- 4. VALIDATE: adapter.validate |
 |                               |-- 5. EXECUTE: adapter.execute ->|
 |                               |<-- resultado -------------------|
 |                               |-- 6. LEARN: save skill -------->|
 |<-- resultado + events -------|                                  |
```

### 1.5 Entidades CTT (generalizadas)

| Entidad | Rol CTT | Descripcion | Campos clave |
|---------|---------|-------------|--------------|
| `Knowledge` | Definiciones | Esquemas/endpoints/nodos del dominio | `domainId`, `operationId`, `displayName`, `description`, `parameters`, `inputs`, `outputs`, `credentials`, `category`, `tags` |
| `Skill` | Patrones | Secuencias de operaciones exitosas | `domainId`, `name`, `description`, `useCases`, `steps[]`, `connections[]`, `status` (experimental/proven/deprecated), `successCount`, `failCount` |
| `Memory` | Aprendizaje | Errores, fixes, optimizaciones | `domainId`, `operationId`, `category` (error/fix/optimization), `content`, `resolution`, `relevance` |
| `Profile` | Configuracion | Conexiones a servicios externos | `domainId`, `name`, `baseUrl`, `credentials`, `metadata` |

#### Base Entity (comun a todas)

```typescript
interface BaseEntity {
  id: string;           // UUID, auto-generado
  type: EntityType;     // 'knowledge' | 'skill' | 'memory' | 'profile'
  domainId: string;     // A que dominio pertenece
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
  tags: string[];       // Para busqueda y filtrado
}
```

### 1.6 Inputs y Outputs del Framework

#### Inputs para crear un dominio

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `domainId` | `string` | Si | Identificador unico del dominio (e.g., "n8n", "wordpress") |
| `adapter` | `DomainAdapter` | Si | Implementacion del adaptador |
| `queryExpansions` | `Record<string, string[]>` | No | Sinonimos para TF-IDF |
| `seeds` | `Skill[]` | No | Patrones iniciales pre-cargados |
| `evalGoals` | `EvalGoal[]` | No | Goals para evaluacion |

#### Output del pipeline autonomo

| Output | Tipo | Descripcion |
|--------|------|-------------|
| `success` | `boolean` | Si la ejecucion completa fue exitosa |
| `result` | `ExecutionResult` | Resultado del adapter.execute() |
| `plan` | `ExecutionPlan` | El plan generado |
| `events` | `AgentEvent[]` | Traza de todo el pipeline |
| `retries` | `number` | Cantidad de reintentos usados |
| `learned` | `Skill \| Memory` | Entidad guardada en el store |

---

## 2. Que NO debe hacer (MUST NOT)

### 2.1 Fuera de Alcance

- No implementar un LLM propio -- se consumen providers existentes (Claude, OpenAI, Ollama, Cloudflare)
- No implementar UI web -- la interfaz es MCP + CLI. Si se necesita web, se delega al consumidor
- No implementar orquestacion multi-agente -- un agente = un shell. La composicion se hace externamente
- No implementar persistencia SQL/Redis -- el store es filesystem content-addressable. Punto.
- No implementar embeddings propios -- la busqueda es TF-IDF. Vector search es opcional via adapter (como en Agent-Shell)
- No implementar un lenguaje de dominio (DSL) -- los planes se expresan como JSON, no como scripts

### 2.2 Anti-patterns Prohibidos

- No hardcodear ningun dominio en el core -- n8n, WordPress, etc. son solo adapters registrables. El core no sabe que es un "nodo n8n" ni un "post de WordPress"
- No depender de runtime dependencies -- igual que Agent-Shell y n8n-a2e, zero deps. Solo Node.js built-ins (crypto, fs, path, http)
- No ejecutar comandos del sistema operativo -- el shell es virtual, no es bash. La ejecucion la maneja el DomainAdapter
- No almacenar secretos en texto plano en el store -- todo pasa por el sanitizer antes de persistir
- No ignorar errores silenciosamente -- cada error se registra como Memory y actualiza el Circuit Breaker
- No usar `any` en la API publica -- TypeScript estricto con tipos genericos

### 2.3 Restricciones de Implementacion

- No usar CommonJS -- ESM exclusivo (`"type": "module"` en package.json)
- No usar decoradores, reflect-metadata ni DI containers -- composicion explicita via constructor injection
- No modificar Agent-Shell core -- se consume como dependencia o se copia. Si hay que extender, se hace via composition, no herencia
- No usar clases abstractas -- interfaces + funciones. Las unicas clases permitidas son las que ya existen en Agent-Shell (`Core`, `CommandRegistry`, `McpServer`, etc.)
- No mezclar sincronico y asincronico -- el pipeline es async end-to-end. Las funciones puras (normalize, sanitize) son sincronicas

---

## 3. Como se que esta bien (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

#### CA-01: Registro de Dominio

```gherkin
DADO un DomainAdapter implementado para un servicio ficticio "echo"
CUANDO lo registro con cttShell.domain('echo').adapter(echoAdapter).register()
ENTONCES los comandos "echo:*" aparecen en el registry
Y "ctt:search echo" retorna las Knowledge entities del dominio
Y "ctt:exec" puede planificar y ejecutar goals del dominio echo
```

#### CA-02: Pipeline Autonomo Completo

```gherkin
DADO un dominio registrado con Knowledge entities y un LLM configurado
CUANDO ejecuto "ctt:exec 'crear workflow que envie email cada lunes'"
ENTONCES el agente pasa por las 6 fases (recall, plan, normalize, validate, execute, learn)
Y si tiene exito, guarda un Skill 'experimental' en el store
Y si falla, guarda un Memory 'error' y actualiza el Circuit Breaker
```

#### CA-03: Guard Rails con Modelo Pequeno

```gherkin
DADO un LLM que retorna JSON con trailing commas, single quotes y thinking tags
CUANDO el Response Normalizer procesa la respuesta
ENTONCES extrae JSON valido aplicando las correcciones necesarias
Y el Plan Normalizer corrige conexiones out-of-bounds y nodos huerfanos
```

#### CA-04: Circuit Breaker

```gherkin
DADO una operacion "smtp.send" que fallo 3 veces consecutivas
CUANDO el agente genera un plan que incluye "smtp.send"
ENTONCES el Circuit Breaker bloquea esa operacion
Y inyecta las razones de fallo como anti-pattern context al LLM
Y solicita al LLM alternativas (e.g., "sendgrid.send")
```

#### CA-05: Aprendizaje CTT (Ciclo Completo)

```gherkin
DADO un goal ejecutado exitosamente 5 veces con variaciones
CUANDO el Skill alcanza successCount >= 5
ENTONCES su status cambia de 'experimental' a 'proven'
Y en futuros recalls, este Skill aparece como few-shot example
Y si el Skill falla 5 veces, su status cambia a 'deprecated'
```

#### CA-06: Multi-Dominio

```gherkin
DADO dominios 'n8n' y 'wordpress' registrados simultaneamente
CUANDO ejecuto "ctt:search webhook"
ENTONCES retorna Knowledge de ambos dominios, rankeadas por TF-IDF
Y cada resultado indica a que dominio pertenece
```

#### CA-07: MCP Compliance

```gherkin
DADO el MCP Server iniciado con transporte stdio
CUANDO un cliente MCP envia initialize -> tools/list -> tools/call
ENTONCES recibe exactamente 2 tools: cli_help y cli_exec
Y cli_exec("ctt:search X") retorna resultados del store CTT
Y cli_exec("ctt:exec 'goal'") ejecuta el pipeline completo
```

#### CA-08: Eval Framework

```gherkin
DADO goals de evaluacion definidos para un dominio
CUANDO ejecuto "ctt:eval" con 2+ modelos LLM
ENTONCES obtengo metricas comparativas: JSON%, Plan%, Valid%, Exec%, Latencia, Tokens
Y "runWithFeedback" muestra la mejora porcentual cuando se inyectan anti-patterns
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Output Esperado | Prioridad |
|----|-----------|-------|-----------------|-----------|
| T01 | Store CRUD basico | save/get/list/delete Knowledge | Entidad persistida y recuperable por id | Alta |
| T02 | SHA-256 dedup | Guardar misma entidad 2 veces | Solo 1 archivo en disco | Alta |
| T03 | TF-IDF search basico | Indexar 10 Knowledge, buscar "email" | Top result es el Knowledge de email | Alta |
| T04 | Query expansion | Buscar "chat" en dominio n8n | Retorna Slack, Discord, Telegram | Alta |
| T05 | Query expansion custom | Dominio con expansions propias | Expansiones del dominio se aplican | Media |
| T06 | Response normalize - thinking tags | `<think>razonamiento</think>{"name":"x"}` | JSON extraido sin tags | Alta |
| T07 | Response normalize - trailing commas | `{"a": 1, "b": 2,}` | JSON valido sin trailing comma | Alta |
| T08 | Response normalize - truncated | `{"name": "x", "steps": [` | JSON auto-cerrado `{"name": "x", "steps": []}` | Alta |
| T09 | Plan normalize - out of bounds | Connection {from: 0, to: 99} con 3 steps | Connection eliminada | Alta |
| T10 | Plan normalize - self loop | Connection {from: 2, to: 2} | Connection eliminada | Alta |
| T11 | Plan normalize - orphan auto-chain | 4 steps, 0 connections | Chain lineal 0->1->2->3 | Alta |
| T12 | Circuit breaker - open | 3 errores para "op.X" | check("op.X").open === true | Alta |
| T13 | Circuit breaker - reset | 3 errores + 1 exito | check("op.X").open === false | Alta |
| T14 | Circuit breaker - anti-patterns | 2 errores con razones diferentes | getAntiPatterns() retorna ambas | Media |
| T15 | Secret sanitizer - layer 1 | Texto con API key conocida | Key reemplazada por {{API_KEY}} | Alta |
| T16 | Secret sanitizer - layer 4 | Texto con "sk-ant-abc123..." | Reemplazado por {{REDACTED_SKANT}} | Alta |
| T17 | Skill lifecycle - experimental | Nuevo skill guardado | status === 'experimental' | Alta |
| T18 | Skill lifecycle - proven | Skill con 5 exitos | status === 'proven' | Alta |
| T19 | Skill lifecycle - deprecated | Skill con 5 fallos | status === 'deprecated' | Alta |
| T20 | Domain registration | Registrar adapter "echo" | Comandos echo:* disponibles | Alta |
| T21 | Autonomous pipeline - success | Goal simple con mock LLM + mock adapter | 6 fases completadas, Skill guardado | Alta |
| T22 | Autonomous pipeline - retry | LLM falla 1 vez, exito al 2do intento | retries === 1, success === true | Alta |
| T23 | Autonomous pipeline - circuit break | Plan con operacion bloqueada | Solicita alternativas al LLM | Media |
| T24 | Inline retry - JSON fix | LLM retorna JSON roto, luego corregido | 2 mensajes en conversacion, plan exitoso | Alta |
| T25 | Eval - single model | 3 goals contra 1 modelo | EvalReport con 3 resultados y summary | Media |
| T26 | Eval - with feedback | 3 goals, round 1 baseline + round 2 feedback | 2 reports comparables | Media |
| T27 | MCP - tools/list | JSON-RPC initialize + tools/list | 2 tools: cli_help, cli_exec | Alta |
| T28 | MCP - ctt:exec via cli_exec | tools/call cli_exec con "ctt:status" | Respuesta con stats del store | Alta |
| T29 | RBAC - permiso denegado | Rol sin permiso "ctt:exec" intenta ejecutar | code: 3, error de permisos | Media |
| T30 | Multi-dominio search | 2 dominios con Knowledge solapado | Resultados de ambos, con domainId | Media |

### 3.3 Metricas de Exito

- [ ] 400+ tests unitarios (heredados de Agent-Shell: 400+, mas nuevos)
- [ ] Cobertura minima: 85% lineas en modulos core
- [ ] Un modelo Qwen 3B con contexto CTT alcanza >= 60% deploy-ready rate en goals simples (eval framework)
- [ ] El pipeline autonomo completa el ciclo recall-plan-normalize-validate-execute-learn en < 30 segundos para goals simples (excluyendo latencia LLM)
- [ ] Registrar un dominio nuevo requiere implementar 1 interfaz (`DomainAdapter`) con 4 metodos requeridos

### 3.4 Definition of Done

- [ ] Codigo implementado en TypeScript estricto (strict: true, no implicit any)
- [ ] Zero runtime dependencies verificado (solo devDependencies para build/test)
- [ ] ESM exclusivo (type: module)
- [ ] Tests pasando con cobertura >= 85%
- [ ] Al menos 1 dominio de ejemplo funcional (e.g., "echo" para testing)
- [ ] MCP server funcional sobre stdio
- [ ] CLI funcional con subcomandos: search, exec, eval, status, domain
- [ ] package.json con exports correctos para consumo como libreria
- [ ] CLAUDE.md con instrucciones para agentes de IA

---

## 4. Que pasa si falla (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Respuesta | Accion |
|--------|-----------|-----------|--------|
| E001 | LLM no retorna JSON valido tras normalizar | `{ phase: 'plan', error: 'Failed to extract valid JSON' }` | Inline retry (hasta maxRetries). Si agota reintentos, guardar Memory con el raw response |
| E002 | Plan tiene operaciones no encontradas en Knowledge | `{ phase: 'validate', error: 'Unknown operation: X' }` | Inline retry con feedback. Inyectar lista de operaciones validas |
| E003 | Circuit Breaker bloquea operaciones del plan | `{ phase: 'circuit-break', blocked: [...] }` | Solicitar alternativas al LLM con razones de bloqueo y resoluciones conocidas |
| E004 | DomainAdapter.execute() falla | `{ phase: 'execute', error: 'Adapter error: ...' }` | Guardar Memory (error), actualizar Circuit Breaker, retry si quedan intentos |
| E005 | LLM provider no responde (timeout) | `{ phase: 'plan', error: 'LLM timeout after Xms' }` | No retry automatico (podria ser rate limit). Guardar Memory |
| E006 | Store filesystem no accesible | Lanzar error sincrono en constructor | No recovery posible. Error de configuracion |
| E007 | Dominio no registrado | `{ code: 2, error: 'Domain not found: X' }` | Listar dominios disponibles en el mensaje |
| E008 | Permiso RBAC denegado | `{ code: 3, error: 'Permission denied' }` | Audit log del intento. No retry |
| E009 | Plan normalizer no puede corregir plan | `{ phase: 'normalize', error: 'Unfixable plan' }` | Inline retry con feedback detallado de los problemas |
| E010 | Secreto detectado en output a guardar | Sanitizar automaticamente antes de persistir | Log warning. Nunca bloquear la persistencia |

### 4.2 Estrategia de Fallback

- Si el LLM primario no responde -> no hay fallback automatico de provider (es responsabilidad del consumidor configurar otro)
- Si el store no puede escribir -> operar en modo read-only (busqueda funciona, aprendizaje no)
- Si un DomainAdapter falla en extractKnowledge() -> usar Knowledge cacheado del store
- Si la normalizacion falla completamente -> retornar el error raw al llamante con el response original para debugging

### 4.3 Logging y Monitoreo

- Nivel de log: configurable (DEBUG, INFO, WARN, ERROR)
- **INFO**: Inicio y fin de cada fase del pipeline, dominio registrado, skill aprendido
- **WARN**: Normalize fixes aplicados, circuit breaker a punto de abrir (2/3 errores), skill degradado
- **ERROR**: LLM fallo, adapter fallo, circuit breaker abierto, secreto detectado
- **DEBUG**: Raw LLM response, JSON pre/post normalizacion, TF-IDF scores
- Audit events (via Agent-Shell AuditLogger): cada `cli_exec` queda registrado con timestamp, comando, resultado, usuario (si RBAC activo)

### 4.4 Recuperacion

- **Retry policy**: hasta `maxRetries` (default 2) por pipeline execution. Inline retry para parsing (default 1 adicional dentro del LLM call)
- **Circuit breaker**: threshold configurable (default 3). Reset automatico con un exito. No hay half-open: un exito resetea a 0
- **Rollback**: no aplica a nivel framework. El DomainAdapter es responsable de implementar rollback si su dominio lo requiere (e.g., n8n adapter puede desactivar un workflow desplegado)

---

## 5. Que supuestos tiene (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] Node.js >= 18 (por ESM nativo + crypto.randomUUID)
- [ ] Filesystem con permisos de lectura/escritura en el directorio del store
- [ ] Al menos 1 LLM provider configurado (API key o Ollama local)
- [ ] Al menos 1 DomainAdapter registrado
- [ ] TypeScript 5.x para compilacion

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica | Reutilizacion |
|-------------|------|---------|---------|---------------|
| Agent-Shell | Lib (codigo fuente) | HEAD | Si | Se copia `src/` completo como base. No como npm dep |
| n8n-a2e storage | Codigo fuente | HEAD | Si | Se adapta `src/storage/store.ts` |
| n8n-a2e search | Codigo fuente | HEAD | Si | Se adapta `src/search/tfidf.ts` |
| n8n-a2e autonomous | Codigo fuente | HEAD | Si | Se adaptan normalize, circuit-breaker, sanitize, workflow-skills |
| n8n-a2e eval | Codigo fuente | HEAD | Si | Se adapta `src/eval/evaluator.ts` |
| Node.js crypto | Built-in | - | Si | SHA-256, randomUUID |
| Node.js fs | Built-in | - | Si | Store filesystem |
| Node.js http | Built-in | - | No | Solo si se usa HTTP/SSE transport |
| TypeScript | Dev | 5.x | Si | Solo compilacion |

### 5.3 Datos de Entrada Esperados

- **Goals**: string en lenguaje natural, cualquier idioma (el LLM maneja la traduccion)
- **Knowledge JSON**: objetos que implementan la interfaz `Knowledge`. Tamanno maximo recomendado: 1000 entities por dominio
- **LLM responses**: texto libre que puede contener JSON dentro de code fences, thinking tags, o texto acompannante
- **Store filesystem**: archivos JSON individuales, UTF-8, hasta ~1MB por entity (en la practica, <100KB)

### 5.4 Estado del Sistema

- El framework es stateless entre sesiones excepto por el store en disco
- El Context Store (Agent-Shell) mantiene estado de sesion en memoria
- El Circuit Breaker se carga lazy desde el store al primer check
- No requiere autenticacion por defecto -- RBAC es opt-in

---

## 6. Que limites tiene (CONSTRAINTS)

### 6.1 Limites Tecnicos

- **Memoria**: sin limite explicito, pero el TF-IDF index carga todas las entities en memoria. Recomendado: < 10,000 entities totales por store
- **Tiempo de respuesta del pipeline**: dominado por la latencia del LLM (tipicamente 2-30s). El framework annade < 100ms de overhead
- **Store**: filesystem, no es concurrent-safe para escritura. Multiples procesos escribiendo al mismo store pueden corromper. Un proceso = un store
- **Search**: TF-IDF, no semantico. Funciona bien para terminos exactos y sinonimos configurados. No entiende significado profundo
- **Tamano del contexto CTT**: el contexto que se envia al LLM (Knowledge + Skills + Memories) esta limitado por la ventana del modelo. El framework no trunca automaticamente -- es responsabilidad del orchestrator generar un contexto que quepa
- **Pipelines**: profundidad maxima 10 (heredado de Agent-Shell)
- **Batch**: tamano maximo 50 comandos (heredado de Agent-Shell)
- **Rate limit**: configurable, default 120 req/min con burst de 20/s (heredado de Agent-Shell)

### 6.2 Limites de Negocio

- El framework no garantiza que los planes generados sean correctos -- depende de la calidad del LLM y del Knowledge disponible
- El ciclo de aprendizaje solo funciona si hay ejecucion real. Dry-run no genera Skills ni Memories
- Los Skills 'proven' no son inmutables -- un cambio en el dominio (e.g., API deprecada) puede invalidarlos. No hay mecanismo automatico de expiracion
- El Circuit Breaker no distingue entre errores transitorios y permanentes. 3 timeouts seguidos bloquean igual que 3 errores de validacion

### 6.3 Limites de Seguridad

- **Autenticacion**: no hay. RBAC es autorizacion, no autenticacion. El llamante debe autenticarse antes de invocar el shell
- **Autorizacion**: RBAC con roles y wildcards (heredado de Agent-Shell). Granularidad: `domain:command`
- **Datos sensibles**: sanitizados antes de persistir en el store. En memoria pueden existir en texto plano durante el pipeline
- **Ejecucion de codigo**: el framework NO ejecuta codigo arbitrario. La ejecucion la maneja el DomainAdapter, que es responsabilidad del desarrollador
- **MCP sobre HTTP/SSE**: sin TLS por defecto. En produccion, poner detras de un reverse proxy con TLS

### 6.4 Limites de Alcance v1

Esta version NO incluye:

- [ ] Persistencia alternativa (SQLite, Redis, S3) -- solo filesystem
- [ ] Busqueda semantica con embeddings -- solo TF-IDF
- [ ] Multi-tenancy (multiples usuarios con stores aislados)
- [ ] Web UI (dashboard, visualizacion de skills, metricas)
- [ ] Orquestacion multi-agente (coordinacion entre varios ctt-shell)
- [ ] Streaming de respuestas LLM (se espera la respuesta completa)
- [ ] Hot-reload de dominios (hay que reiniciar para agregar/quitar)
- [ ] Versionado de Skills (no hay diff entre versiones de un mismo patron)
- [ ] Exportar/importar stores entre instancias
- [ ] Plugin system formal (los DomainAdapters son el mecanismo de extension)

**Consideraciones futuras (v2+)**:

- SQLite adapter para el store (Agent-Shell ya tiene `SQLiteStorageAdapter`)
- MiniMemory integration para busqueda semantica (Agent-Shell ya tiene el adapter)
- OpenSpec adapter para generar DomainAdapters desde specs OpenAPI (Agent-Shell ya tiene `OpenSpecAdapter`)
- Dashboard web para observabilidad del ciclo CTT
- Versionado de Skills con diff y rollback

---

## 7. Ciclo CTT: Recall -> Execute -> Learn (Detalle)

### 7.1 Recall

```typescript
// Input: goal (string), domainId? (string)
// Output: CTTContext

interface CTTContext {
  knowledge: Knowledge[];       // Operaciones relevantes (top N por TF-IDF)
  skills: Skill[];              // Patrones exitosos similares (few-shot)
  memories: Memory[];           // Errores y fixes relevantes
  antiPatterns: AntiPattern[];  // Del Circuit Breaker
  queryExpansions: string[];    // Terminos expandidos usados
}
```

El recall:
1. Tokeniza el goal con Porter stemming
2. Expande con sinonimos del dominio
3. Busca en Knowledge (operaciones disponibles)
4. Busca en Skills (patrones exitosos como few-shot)
5. Busca en Memories (errores y fixes relevantes)
6. Consulta Circuit Breaker para anti-patterns activos
7. Compone un `CTTContext` que se inyecta en el prompt del LLM

### 7.2 Execute (via el pipeline de 6 fases)

El contexto CTT se serializa como parte del prompt:

```
## Operaciones Disponibles
[Knowledge serializado: tipo, nombre, parametros, descripcion]

## Patrones Exitosos Previos (few-shot)
[Skills serializados: nombre, descripcion, steps, connections]

## Errores Conocidos (evitar)
[Memories + AntiPatterns: operacion, error, resolucion]

## Goal
[El goal del usuario]
```

### 7.3 Learn

Despues de cada ejecucion:

| Resultado | Accion |
|-----------|--------|
| Exito | `saveSkill()` con status 'experimental'. Si ya existe un Skill similar, incrementar `successCount`. Si `successCount >= 5`, promover a 'proven' |
| Fallo de validacion | `saveMemory(category: 'error')` con los errores. `circuitBreaker.recordError()` |
| Fallo de ejecucion | `saveMemory(category: 'error')` con el error del adapter. `circuitBreaker.recordError()`. Si hay resolucion conocida, `saveMemory(category: 'fix')` |
| Fix aplicado (retry exitoso) | `saveMemory(category: 'fix')` con el error original y la resolucion. `saveExecutionFix()` |

---

## 8. Estructura del Proyecto

```
ctt-shell/
  src/
    types/                    # Tipos compartidos
      entities.ts             # Knowledge, Skill, Memory, Profile (genericos)
      plan.ts                 # ExecutionPlan, ExecutionStep, StepConnection
      domain.ts               # DomainAdapter, DomainConfig
      index.ts

    storage/                  # Store content-addressable
      store.ts                # Adaptado de n8n-a2e (EntityType generico)
      index.ts

    search/                   # Motor de busqueda
      tfidf.ts                # Adaptado de n8n-a2e (expansions inyectables)
      index.ts

    guardrails/               # Guard rails
      normalize-response.ts   # De n8n-a2e (sin cambios)
      normalize-plan.ts       # Adaptado (ExecutionPlan generico)
      circuit-breaker.ts      # Adaptado (operationId generico)
      sanitize.ts             # De n8n-a2e (sin cambios)
      inline-retry.ts         # Extraido del AutonomousAgent
      index.ts

    domain/                   # Registro de dominios
      registry.ts             # DomainRegistry
      adapter.ts              # DomainAdapter interface + helpers
      index.ts

    agent/                    # Agentes
      autonomous.ts           # Pipeline completo con CTT cycle
      interactive.ts          # Con confirmacion humana
      recall.ts               # Modulo de recall (search + compose context)
      learn.ts                # Modulo de learn (save skills/memories)
      index.ts

    llm/                      # Providers LLM
      provider.ts             # Interface + factory
      claude.ts               # Anthropic
      openai.ts               # OpenAI
      ollama.ts               # Ollama local
      cloudflare.ts           # Workers AI
      index.ts

    eval/                     # Framework de evaluacion
      evaluator.ts            # ModelEvaluator adaptado
      goals.ts                # EvalGoal types + helpers
      feedback.ts             # runWithFeedback
      index.ts

    shell/                    # Agent-Shell engine (copiado)
      core/                   # Core orquestador
      parser/                 # Parser AST
      executor/               # Executor con timeout
      command-registry/       # Registry con semver
      command-builder/        # Fluent builder
      context-store/          # Sesion + history
      jq-filter/              # Filtrado JQ
      vector-index/           # Vector search (opcional)
      security/               # RBAC + Audit + Secrets
      mcp/                    # MCP server
      index.ts

    cli/                      # CLI para dev/test
      cli.ts                  # Subcomandos: search, exec, eval, status, domain
      index.ts

    index.ts                  # Export publico del framework

  domains/                    # Adapters de ejemplo
    echo/                     # Dominio de testing
      adapter.ts
      knowledge.ts
      goals.ts
    n8n/                      # Adapter n8n (extraido de n8n-a2e)
      adapter.ts
      extractor.ts
      composer.ts
      validator.ts
    wordpress/                # Adapter WordPress (extraido de wp-a2e)
      adapter.ts

  tests/
    unit/                     # Tests unitarios por modulo
    integration/              # Tests de pipeline completo
    fixtures/                 # Datos de test

  package.json
  tsconfig.json
  CLAUDE.md
```

---

## 9. API Publica

### 9.1 Creacion del Shell

```typescript
import { createCttShell } from 'ctt-shell';

const shell = createCttShell({
  storePath: '.ctt-shell/store',
  llm: { provider: 'ollama', model: 'qwen2.5:3b' },
  // Opcional
  rbac: { roles: [...] },
  rateLimit: { maxRequests: 120 },
  logging: { level: 'INFO' },
});
```

### 9.2 Registro de Dominios

```typescript
import { EchoAdapter } from './domains/echo';

shell.domain('echo', new EchoAdapter());
// o con config:
shell.domain('n8n', new N8nAdapter({ baseUrl: '...', apiKey: '...' }));
```

### 9.3 Ejecucion Directa (API TypeScript)

```typescript
// Busqueda
const results = await shell.search('send email', { domain: 'n8n', limit: 10 });

// Pipeline autonomo
const result = await shell.exec('crear workflow que envie email cada lunes', {
  domain: 'n8n',
  maxRetries: 2,
});

// Evaluacion
const report = await shell.eval(goals, models);
```

### 9.4 Ejecucion via MCP

```typescript
shell.startMcp({ transport: 'stdio' });
// o
shell.startMcp({ transport: 'http', port: 3001 });
```

### 9.5 Ejecucion via CLI

```bash
ctt-shell search "send email" --domain n8n
ctt-shell exec "crear workflow de email semanal" --domain n8n
ctt-shell eval --goals goals.json --models models.json
ctt-shell status
ctt-shell domain list
ctt-shell domain extract n8n  # Re-extraer Knowledge del dominio
```

### 9.6 Comandos Registrados en el Shell

| Namespace | Comando | Descripcion |
|-----------|---------|-------------|
| `ctt` | `search <query>` | Busqueda TF-IDF en Knowledge + Skills + Memories |
| `ctt` | `recall <goal>` | Recall completo: genera CTTContext |
| `ctt` | `plan <goal>` | Genera ExecutionPlan sin ejecutar |
| `ctt` | `exec <goal>` | Pipeline autonomo completo |
| `ctt` | `learn <json>` | Registrar Skill o Memory manualmente |
| `ctt` | `status` | Estado del store, circuit breakers, skills por status |
| `ctt` | `eval` | Ejecutar evaluacion contra modelos |
| `ctt` | `domains` | Listar dominios registrados |
| `<domain>` | `extract` | Re-extraer Knowledge del dominio |
| `<domain>` | `*` | Comandos especificos registrados por el adapter |
| *(builtins)* | `search` | Busqueda semantica de comandos (Agent-Shell) |
| *(builtins)* | `describe` | Describe un comando registrado |
| *(builtins)* | `history` | Historial de ejecuciones |
| *(builtins)* | `context` | Context store (sesion) |

---

## 10. Reutilizacion de Codigo Existente

### 10.1 Mapa de Reutilizacion

| Origen | Archivo(s) | Destino en ctt-shell | Tipo de reutilizacion |
|--------|-----------|----------------------|----------------------|
| Agent-Shell | `src/core/` | `src/shell/core/` | Copia directa |
| Agent-Shell | `src/parser/` | `src/shell/parser/` | Copia directa |
| Agent-Shell | `src/executor/` | `src/shell/executor/` | Copia directa |
| Agent-Shell | `src/command-registry/` | `src/shell/command-registry/` | Copia directa |
| Agent-Shell | `src/command-builder/` | `src/shell/command-builder/` | Copia directa |
| Agent-Shell | `src/context-store/` | `src/shell/context-store/` | Copia directa |
| Agent-Shell | `src/jq-filter/` | `src/shell/jq-filter/` | Copia directa |
| Agent-Shell | `src/vector-index/` | `src/shell/vector-index/` | Copia directa |
| Agent-Shell | `src/security/` | `src/shell/security/` | Copia directa |
| Agent-Shell | `src/mcp/` | `src/shell/mcp/` | Copia directa |
| n8n-a2e | `src/storage/store.ts` | `src/storage/store.ts` | Adaptado: EntityType generico |
| n8n-a2e | `src/search/tfidf.ts` | `src/search/tfidf.ts` | Adaptado: expansions inyectables |
| n8n-a2e | `src/autonomous/normalize.ts` | `src/guardrails/normalize-response.ts` | Copia directa (ya generico) |
| n8n-a2e | `src/autonomous/normalize-plan.ts` | `src/guardrails/normalize-plan.ts` | Adaptado: ExecutionPlan generico |
| n8n-a2e | `src/autonomous/circuit-breaker.ts` | `src/guardrails/circuit-breaker.ts` | Adaptado: operationId generico |
| n8n-a2e | `src/autonomous/sanitize.ts` | `src/guardrails/sanitize.ts` | Copia directa (ya generico) |
| n8n-a2e | `src/autonomous/workflow-skills.ts` | `src/agent/learn.ts` | Adaptado: Skill/Memory genericos |
| n8n-a2e | `src/autonomous/autonomous-agent.ts` | `src/agent/autonomous.ts` | Refactorizado: DomainAdapter en vez de Orchestrator |
| n8n-a2e | `src/eval/evaluator.ts` | `src/eval/evaluator.ts` | Adaptado: multi-dominio |
| n8n-a2e | `src/llm/` | `src/llm/` | Copia directa |
| n8n-a2e | `src/types/entities.ts` | `src/types/entities.ts` | Reescrito: genericos |

### 10.2 Estimacion de Codigo Nuevo vs Reutilizado

| Categoria | Lineas estimadas | % del total |
|-----------|-----------------|-------------|
| Agent-Shell copiado directamente | ~4,000 | 40% |
| n8n-a2e adaptado | ~1,500 | 15% |
| n8n-a2e copiado directamente | ~500 | 5% |
| Codigo nuevo (domain layer, agent refactor, types, CLI, glue) | ~4,000 | 40% |
| **Total estimado** | **~10,000** | **100%** |

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| CTT | Context-Time Training. Tesis que demuestra que modelos pequenos igualan a grandes cuando reciben contexto estructurado |
| Knowledge | Entidad que describe una operacion/endpoint/nodo disponible en un dominio |
| Skill | Patron de ejecucion aprendido (secuencia de operaciones exitosa) con lifecycle |
| Memory | Hecho aprendido de una ejecucion (error, fix, optimizacion) |
| Profile | Configuracion de conexion a un servicio externo |
| DomainAdapter | Interfaz que conecta un dominio especifico al framework |
| Guard Rail | Mecanismo de proteccion que compensa errores de modelos LLM pequenos |
| Circuit Breaker | Patron que bloquea operaciones tras fallos consecutivos |
| Inline Retry | Retroalimentar errores al LLM dentro de la misma conversacion para autocorreccion |
| Few-shot | Incluir ejemplos exitosos previos en el prompt del LLM |
| Anti-pattern | Error conocido que se inyecta como contexto negativo al LLM |
| Content-addressable | Storage donde el contenido determina la ubicacion (SHA-256 hash) |
| TF-IDF | Term Frequency-Inverse Document Frequency. Algoritmo de ranking por relevancia textual |
| MCP | Model Context Protocol. Protocolo estandar para que LLMs invoquen herramientas |
| Pipeline | Encadenamiento de comandos donde el output de uno es input del siguiente |

### B. Referencias

- Agent-Shell: https://github.com/MauricioPerera/Agent-Shell
- n8n-a2e: https://github.com/MauricioPerera/n8n-a2e
- wp-a2e: https://github.com/MauricioPerera/wp-a2e
- CTT thesis (RepoMemory v2): Referenciado en n8n-a2e README
- MCP specification: https://modelcontextprotocol.io
- n8n API docs: https://docs.n8n.io/api/

### C. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-03-16 | MauricioPerera + Claude Opus 4.6 | Version inicial del contrato |
