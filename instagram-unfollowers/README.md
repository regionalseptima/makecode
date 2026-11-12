# Instagram: quién no me sigue de vuelta

Script que muestra, de las cuentas que sigues en Instagram, cuáles no te siguen
a ti, con un botón **Dejar de seguir** junto a cada una.

Se ejecuta en tu navegador, dentro de tu sesión de instagram.com. No pide tu
contraseña ni envía datos a ningún otro sitio.

## Cómo usarlo

1. En un ordenador, abre <https://www.instagram.com> e inicia sesión.
2. Abre la consola del navegador: `F12` (o `Cmd+Opt+J` en Mac) y pestaña
   **Consola**.
3. Copia todo el contenido de [`instagram-unfollowers.js`](instagram-unfollowers.js),
   pégalo en la consola y pulsa `Enter`. Si el navegador te pide confirmar el
   pegado, escribe lo que indique (en Chrome, `allow pasting`).
4. Aparece un panel a la derecha. Cuando termine de leer tus seguidos, lista
   los que no te siguen de vuelta. Puedes buscar por nombre, abrir el perfil
   pulsando el usuario y dejar de seguir con un clic.

Para cerrarlo, pulsa **Cerrar**. Para actualizar la lista, vuelve a pegar el
script.

## Cosas a tener en cuenta

- **Ve despacio.** Instagram limita las acciones automatizadas. El script lee
  las listas con pausas (unos 2–3 minutos por cada 1000 seguidos) y espacia
  los "dejar de seguir", pero si dejas de seguir a muchas cuentas seguidas
  Instagram puede bloquear temporalmente esa acción. Como referencia prudente,
  no pases de unas pocas decenas por hora.
- **No hay botón de "dejar de seguir a todos"** a propósito: es lo que más
  bloqueos provoca.
- Usa las mismas direcciones internas que la web de Instagram, que no son una
  API oficial y pueden cambiar sin aviso. Si deja de funcionar, el panel lo
  indica. El uso de scripts va contra los términos de uso de Instagram; úsalo
  bajo tu responsabilidad.
- Si aparece el aviso de "método alternativo", comprueba el perfil antes de
  dejar de seguir: en ese modo la lista de seguidores puede venir incompleta.
