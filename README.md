# Pirate Token Claim All · fork con límite de peticiones

Extensión de navegador que reclama en la tienda web de Fortnite todas las ofertas que ya aparecen a **0 paVos** mientras tu Pirate Shop Access está activo. Es un fork de [Napzeee/fortnite-pirate-token-claim-all-extension](https://github.com/Napzeee/fortnite-pirate-token-claim-all-extension) (MIT) centrado en un problema concreto: la versión 1.0.0 lanzaba varias peticiones a la vez y Epic respondía **HTTP 429**, abortando el lote con «Hit a little snag».

## Qué cambia respecto a la 1.0.0

| Problema | Corrección |
| --- | --- |
| 4 canjes en paralelo | Los canjes son **estrictamente secuenciales**, con 1,2 s de separación y variación aleatoria. |
| 3 peticiones de lectura a la vez al abrir | La tienda, el token CSRF y el saldo se piden **uno detrás de otro**. |
| Un 429 cancelaba todo el lote | Cada petición espera y reintenta: usa `Retry-After` si Epic lo envía y, si no, retrocede 5 s, 10 s, 20 s… hasta 5 min, con un máximo de 8 reintentos. |
| El modal se quedaba en «Hit a little snag» | Mientras espera muestra «Epic is asking us to slow down. Waiting Ns…» y continúa solo. |
| Un fallo aislado marcaba el resto como fallido | Solo se marca la oferta afectada; el resto sigue su curso. |

El canje sigue enviando `expectedTotalPrice=0`, así que el servidor rechaza cualquier artículo que no sea realmente gratuito. El saldo de paVos se comprueba antes y después del lote y el proceso se detiene si baja.

## Instalación

1. Descarga el repositorio (botón **Code → Download ZIP**) y descomprímelo.
2. Abre `brave://extensions`, `chrome://extensions` o `edge://extensions`.
3. Activa **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida** y selecciona la carpeta **`src`**, la que contiene `manifest.json`. No abras ningún archivo suelto.
5. Recarga la pestaña de la tienda si ya la tenías abierta.

## Uso

1. Activa el token dentro del juego (tienda → **Activate Now**).
2. Entra en <https://www.fortnite.com/item-shop> con la misma cuenta.
3. Pulsa **Claim all free**, junto al botón de comprar paVos, o **Claim everything** en el icono de la extensión.

La extensión **no arranca sola** al abrir la tienda: solo empieza con una de esas dos pulsaciones. `Esc` o **Stop** detienen el proceso; lo ya reclamado se conserva y **Try again** retoma lo pendiente.

## Cuándo aparece un 429

Epic limita por ráfagas de peticiones, no por número de artículos. Si aun así aparece:

- Deja la pestaña abierta: la extensión espera sola y muestra la cuenta atrás.
- No recargues ni pulses varias veces: cada intento adicional alarga el bloqueo.
- Si el bloqueo supera los 8 reintentos, espera unos minutos y pulsa **Try again**. Reintentar es seguro: los artículos que ya tienes se detectan como propios y no se vuelven a comprar.

## Límites conocidos

- Es una herramienta **no oficial**. Los [términos de Epic Games](https://legal.epicgames.com/epicgames/tos) prohíben automatizar con bots el uso de sus productos; úsala bajo tu responsabilidad y solo con tu propia cuenta.
- Solo funciona en escritorio con Chrome, Edge o Brave. Lo reclamado aparece en todas las plataformas.
- No cubre packs de dinero real, regalos, pases de batalla ni más de un Sidekick, porque el propio token no los cubre.
- No se ha probado canje real: no se activó ningún token ni se gastó nada durante el desarrollo.

## Créditos y licencia

Código original de [Napzeee](https://github.com/Napzeee/fortnite-pirate-token-claim-all-extension), licencia MIT. Las modificaciones de este fork mantienen la misma licencia; consulta [LICENSE](LICENSE). El arte del token pertenece a Epic Games y no está cubierto por la licencia.
