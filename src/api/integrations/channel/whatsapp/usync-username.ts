/**
 * PARCHE PD (9 sep 2026): preguntarle a WhatsApp el NOMBRE DE USUARIO de un `@lid`.
 *
 * Quien oculta su numero llega solo como `<identificador>@lid`, y el mensaje NO trae su
 * usuario: lo unico que viene es el `pushName`, que es el nombre del perfil y puede ser
 * cualquier cosa (emojis incluidos). Peticion de Luis: «si tiene nombre de usuario quiero
 * ver su nombre de usuario, no 3432423@lid».
 *
 * El usuario no llega solo: HAY QUE PEDIRLO, con una consulta USync sobre el protocolo
 * `username`. Nuestro Baileys (7.0.0-rc.9) todavia no lo trae --su USyncContactProtocol
 * dice literalmente «TODO: Implement type / username fields (not yet supported)»-- y si
 * lo trae la rc14. En vez de saltar cinco versiones en la libreria que sostiene la
 * conexion de WhatsApp de los cinco clientes, se porta aqui la clase, que son estas
 * lineas: `USyncQuery.protocols` es un array publico y admite protocolos de fuera.
 *
 * `USyncLIDProtocol` --consultar por `@lid`-- SI existe ya en la rc.9.
 */
export class USyncUsernameProtocol {
  public name = 'username';

  public getQueryElement() {
    return {
      tag: 'username',
      attrs: {},
    };
  }

  public getUserElement() {
    return null;
  }

  public parser(node: any): string | null {
    if (node.tag === 'username') {
      return typeof node.content === 'string' ? node.content : null;
    }
    return null;
  }
}
