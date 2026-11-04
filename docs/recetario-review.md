# Recetario de cocina: revisión del piloto

Cuando falta un precio o una equivalencia, la receta afectada conserva el subtotal conocido y el total pendiente. Las demás recetas se pueden revisar. Esta primera etapa permite abrir un conjunto de recetas conciliado, ver ingredientes y preparaciones, costos netos, guarniciones, opciones alternativas y datos pendientes.

## Alcance de esta rama

- Motor puro, sin I/O: último costo por referencia temporal propia, sin promediar compras; preparaciones por salida útil y rendimientos una vez. Rechaza costos de otras cuentas, locales o áreas. Equivalencias masa/volumen específicas y respaldadas.
- Vista en la navegación del CMS para Superadmin o usuarios con permiso explícito `recipes`. No se asigna este permiso a usuarios existentes. Revisión por local/cuenta Food.
- Importación de un archivo preparado en memoria del navegador. No transmite el contenido, no usa almacenamiento local persistente y lo descarta al cambiar de local/salir de la vista. Un cálculo no equivale a aprobación culinaria.
- Frecuencias de guarniciones con período explícito, opciones alternativas y adicionales separados. Si faltan frecuencias, no inventa ponderación. Márgenes requieren precio de venta neto y fuente; alternativas con diferentes costos no reciben un margen único engañoso.
- Importador de la exportación conciliada existente; verifica costos, subtotales, opciones y ponderados antes de aceptar la conversión. La referencia temporal del importador es la lectura original, no una fecha de ingreso SH inventada.

Los archivos reales, nombres, fotos, identificadores y costos de clientes son privados. No se incluyen en este repositorio público, fixtures, assets ni bundle del cliente. Las pruebas usan datos sintéticos.

## Verificación local

```sh
npm ci
npm run test:recipes
npm run build
# Solo con archivos privados propios, fuera del repositorio:
node scripts/recipes-import-pilot.mjs /ruta/privada/piloto.json /ruta/privada/costos.json /ruta/privada/recetario.json
npm run dev -- --host 127.0.0.1 --port 4178
# Abrir http://127.0.0.1:4178/recetario-preview.html y seleccionar el archivo privado.
```

La página de desarrollo `recetario-preview.html` usa la misma vista/motor. No se agrega al build productivo. El servidor dev debe escuchar solo en localhost durante pruebas con datos reales. Importar JSON calcula su contenido; no ejecuta scripts ni confía en totales precalculados del archivo.

## Integración posterior

Persistencia privada/versionado de recetas, aprobación culinaria, autorización por local en servidor y sincronización autenticada del último costo de Sculpture quedan para la siguiente etapa. No hay tablas nuevas, migraciones ni endpoints de escritura en este cambio. No se modifica `cms_store`, ni credenciales, ni recetas/períodos/facturas de SH. No se afirma actualización automática ni acceso de clientes implementado. Cualquier futura API necesita autorización por local en servidor; el filtro de la vista por sí solo no es una frontera de seguridad.

Revisar el piloto con datos completos o pendientes explícitos antes de extenderlo a la carta. Publicar exige el visto bueno del dueño del CMS: `main` despliega automáticamente. Esta rama se mantiene para revisión, sin merge ni despliegue.
