# dareskro — film de présentation façon « La Linea »

Durée : 2 min 00 (3 600 images à 30 i/s, 1920×1080). Un seul trait blanc continu,
un fond uni par séquence, aucun mot à l'écran sauf le carton de fin et les
incrustations de vérification. Le bonhomme parle un charabia italien (voix de
synthèse du Mac, montée d'un ton). Le crayon est la seule chose « réelle ».

| # | Temps | Fond | Ce qui se passe |
|---|---|---|---|
| 0 | 0:00–0:10 | bleu | La ligne se trace depuis la gauche. Le bonhomme (le pharmacien) sort du trait et marche. Le crayon dessine une croix de pharmacie, puis un calendrier avec le dimanche entouré. Il regarde, grommelle : c'est son dimanche de garde. |
| 1 | 0:10–0:28 | ocre | Trou n° 1 : la paie du dimanche. Le crayon empile au-dessus du trou un planning, un badge, puis une convention collective épaisse comme un annuaire. Le bonhomme s'énerve (il tremble, charabia furieux). La pile lui tombe dessus, il ressort la tête des papiers. |
| 2 | 0:28–0:48 | vert | Le crayon dessine un petit robot (l'agent). Les papiers glissent dans le robot, qui ressort une feuille : 466.57. Le bonhomme se méfie, tapote la feuille du doigt. Le crayon dessine une personne (chignon) qui coche la feuille d'un grand V : rien ne bouge sans elle. La feuille cochée se pose sur le trou, il passe dessus. |
| 3 | 0:48–1:12 | bordeaux | Trou n° 2 : qui garde l'argent jusqu'au jour de paie ? Le crayon dessine un coffre, le bonhomme tend la main (« soldini ! »). Le coffre rétrécit et devient un cadenas posé sur la ligne elle-même : le registre XRPL. Il tire dessus, rien. Le patron (haut-de-forme) arrive de droite et tire aussi, rien. Les deux haussent les épaules. |
| 4 | 1:12–1:30 | bleu | Le crayon dessine un Ledger Nano. L'écran affiche le montant, la date et le destinataire ; le bonhomme se penche, lit, hoche la tête, appuie. Le cadenas se ferme : « tic ». Le temps passe : un soleil traverse l'écran. |
| 5 | 1:30–1:48 | orange | Une petite horloge à pattes (l'oracle) arrive en trottinant, s'arrête devant le cadenas, ses aiguilles tombent sur midi : le cadenas s'ouvre tout seul. Des pièces coulent le long de la ligne vers l'employé qui attendait à droite et saute de joie. Incrustation : le lien de la vraie transaction testnet. Le bonhomme hausse les épaules, sifflote, repart. |
| 6 | 1:48–2:00 | bleu nuit | Carton : **dareskro**. Puis « evidence · code · signature ». Puis « XRP Ledger testnet · Ledger Nano X · AI & Fintech XRP Ledger Hackathon, New York 2026 ». Fondu. |

## Répliques (charabia, voix Alice it_IT ×1,3)

- 0:07 « Eh… la farmacìa. Domenìca, oh ! »
- 0:20 « Ma che stracatùffolo è questo ! Pianìngo, badgìno, convenziòne ! Porcaccia miseria ! »
- 0:26 « Mmmh ! Bruttolo ! »
- 0:37 « Mmm ? Robottìno… quattrocento sessantasei ? Mah. »
- 0:43 « Ah, va bene, va bene. »
- 0:56 « Oooh ! Soldìni ! »
- 1:01 « Nnngh ! Mannàggia ! »
- 1:06 (patron, voix Grandpa) « Nnngh ! Niènte ! »
- 1:08 (les deux) « Bah ! »
- 1:16 « Quattrocento sessantasei… trentuno ottobre… erre tre kappa… ah ah. »
- 1:26 « Bene. »
- 1:31 « Oh ! L'orològgio ! »
- 1:43 sifflotement (synthèse)

## Bruitages

Crayon qui gratte pendant chaque dessin, « tic » du cadenas (1:23), tintement
des pièces (1:37–1:43), petit « plop » quand le bonhomme sort du trait.

## Ce que le film ne dit pas et que le README dit

Le film montre *quoi* ; le README et les transactions montrent *comment*. Les
quatre liens testnet du README (EscrowCreate signé sur le Ledger, finish refusé
avant la date, finish par l'oracle, cancel refusé) sont la preuve ; le film est
l'invitation à aller les lire.

## Variante NEAR

Même film. Seuls changent, par `scenarios/near.json` : ce que le bonhomme lit
sur l'appareil (séquence 4 : le montant en NEAR, la date, le destinataire du
vrai essai testnet), l'incrustation de la séquence 5 (le `finish()` soumis par
l'oracle, lien testnet.nearblocks.io) et le carton de fin (NEAR testnet · un
contrat sans clés · NEAR Hackathon, novembre 2026). Le cadenas posé sur la
ligne est cette fois un contrat dont on a supprimé les clés : personne ne peut
plus en changer le code ni en sortir l'argent autrement que par ses quatre
méthodes.
