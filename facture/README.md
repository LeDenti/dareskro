# facture — l'avance sur facture, le septième cas

Un fournisseur tient une facture sur un client final, payable à 30, 60 ou 90 jours, et veut
l'argent maintenant. Un **pool** lui avance 90 % du montant ; à l'échéance le client paie le
pool ; le pool garde ses frais et rend le solde au fournisseur. Si le client ne paie pas, le
pool a perdu, sauf recours contractuel contre le fournisseur. Avancer de l'argent contre une
facture est une **activité de prêt** : la section « limites honnêtes » le dit avant tout.

Deux versions, toutes deux mesurées le 01/11/2026, toutes deux dans ce dossier :

1. **La version honnête d'aujourd'hui, sur testnet XRPL** : le pool est un compte à
   **trois signataires, deux signatures** (modèle du dépôt de garantie, `depot/`). Les trois
   sièges : l'**IA** qui rassemble les preuves et propose (son analyse est hachée et ancrée
   avant toute signature, comme `paie/ancrer.mjs` ancre le bulletin), la **politique de
   risque** (du code déterministe, plafond par débiteur et plafond de concentration, qui
   refuse au-delà) et l'**opérateur humain**. La facture est un jeton (XLS-33) portant
   l'empreinte du dossier ; l'avance et le remboursement sont des `Payment` ordinaires ; le
   remboursement peut être verrouillé dans un escrow, **en XRP seulement**.
2. **Le prototype XLS-65 + XLS-66 sur devnet** : le pool est un coffre (`Vault`), dareskro
   est le courtier (`LoanBroker`), son `DebtMaximum` est le plafond de concentration **tenu
   par le registre**, l'avance est un `Loan`, le défaut une opération standard. Ces
   amendements ne sont pas activés sur mainnet (21 et 19 validateurs sur 35, seuil 28, sans
   date) : rien de cette version ne peut servir aujourd'hui, et elle dit exactement ce que la
   version 1 ne peut pas faire.

Code en anglais comme le reste du dépôt, documentation en français. Scripts : `facture.mjs`
(le dossier et son empreinte), `politique.mjs` (la politique de risque, 14 auto-vérifications),
`analyse.mjs` (le siège IA), `registre.mjs` (les transactions), `demo_avance_facture.mjs`
(la mesure testnet, `run.log`, `compte_rendu.json`), `devnet_xls65_66.mjs` (la mesure devnet,
`run_devnet.log`, `compte_rendu_devnet.json`), `service.mjs` (le service derrière l'écran du
pupitre, `app/`, cas « Invoice advance · pool 2/3 »), `tableaux.mjs` (les tableaux ci-dessous,
régénérés depuis les comptes rendus : aucun hash recopié à la main).

## Ce que le registre impose, ce qu'un signataire impose

| | Version 1 — compte 2/3 (testnet, utilisable) | Version 2 — XLS-65/66 (devnet seulement) |
|---|---|---|
| Qui détient l'argent des prêteurs | un compte sans clé maîtresse, 2 signatures sur 3 | un pseudo-compte de coffre, sans clé du tout ; les prêteurs détiennent des parts (MPT) |
| Plafond de concentration | **un signataire** (la politique de risque) ; mesuré : avec deux autres signatures le registre paie quand même (`tesSUCCESS`) | **le registre** : `DebtMaximum` du courtier ; mesuré : `tecLIMIT_EXCEEDED`, aucune signature ne passe outre |
| Date d'échéance | tenue par le registre **si** le client a verrouillé un escrow XRP (`tecNO_PERMISSION` avant la date) ; sinon une promesse | tenue par le registre : `NextPaymentDueDate`, période de grâce, `tecTOO_SOON` avant |
| Défaut | le pool l'**écrit** (AccountSet 2/3, mémo) et ne peut rien prélever ; recours = contrat | `LoanManage tfLoanDefault` : le registre réalise la perte, d'abord sur la couverture du courtier puis sur les parts |
| Qui peut rembourser | n'importe qui peut payer le pool | seul l'emprunteur (`LoanPay` d'un tiers : `tecNO_PERMISSION`) |
| Monnaie | XRP (tient lieu d'euros : aucun jeton euro n'est séquestrable, mesuré 08/09 et 27/10/2026) | XRP, ou tout actif du coffre |
| Disponible sur mainnet | oui | non (21/35, 19/35, 19/35 validateurs au 01/11/2026) |

## Version 1 — le pool à trois sièges, aujourd'hui

**Le pool.** Un compte créé par l'opérateur avec la réserve (3 XRP), `SignerListSet` quorum 2
sur {IA, politique de risque, opérateur} (poids 1 chacun), `AccountSet asfDisableMaster`.
Deux prêteurs y apportent 80 + 80 XRP : c'est le capital. L'IA, la politique et l'opérateur
ne détiennent rien ; dareskro, qui opère les trois machines, n'a jamais la main seul.

**La facture.** Un dossier JSON (fournisseur, client, montant, émission, échéance, pièces avec
leur SHA-256, avance, frais, pool) canonisé et haché : l'**empreinte**. Le fournisseur émet un
jeton XLS-33 à une unité (`MPTokenIssuanceCreate`, transférable, métadonnées = identifiant,
empreinte, montant, échéance, jamais un nom). Quand l'avance est accordée, le pool accepte le
jeton (`MPTokenAuthorize`, multisigné) et le fournisseur le lui remet : la **créance est cédée**
au pool, et le jeton revient à l'émetteur quand elle est éteinte (payée ou rachetée). Le jeton
est la trace de la cession, pas la cession elle-même (qui est un contrat, voir plus bas).

**Les trois sièges, dans l'ordre.**
1. *L'IA propose.* `analyse.mjs` lit sur le registre l'âge, l'activité, le solde du
   fournisseur et du client et les remboursements antérieurs de ce client au pool, vérifie les
   pièces par leur hash, écrit un mémo (faits, réserves, recommandation), le hache et **ancre
   le hash** par un `AccountSet` de son propre compte (mémos `dareskro/analyse-sha256`,
   `dareskro/facture-sha256`). Le mémo reste hors chaîne (`sortie/analyses/`). **Stand-in** : la
   rédaction du mémo est faite par ce script, déterministe, à partir de faits réellement lus ;
   aucun modèle de langage n'est appelé dans ce prototype. En production un modèle lit le PDF,
   les comptes, les courriels ; ce qui ne change pas, c'est le contrat du siège : des preuves
   avec leur source, une recommandation, un hash ancré **avant** la signature, aucun pouvoir
   de payer seul.
2. *La politique de risque décide.* `politique.mjs`, sans réseau, sans modèle : plafond de
   concentration (30 % du capital par débiteur, nouvelle avance comprise), plafond absolu
   (100 XRP par débiteur), avance ≤ 90 %, échéance ≤ 90 jours, montant minimal, et une analyse
   de l'IA **ancrée et portant sur ce dossier** obligatoire. Mêmes entrées, même réponse.
   Elle signe si et seulement si elle dit oui. `node politique.mjs` : 14 auto-vérifications.
3. *Deux signatures paient.* L'avance est un `Payment` du pool au fournisseur, multisigné,
   mémos : `dareskro/case`, `dareskro/facture-sha256`, `dareskro/analyse-sha256`,
   `dareskro/echeance`. Le registre compte les signatures et rien d'autre.

**Le remboursement.** Deux chemins, tous deux mesurés. Le client *verrouille* : `EscrowCreate`
en XRP vers le pool, `FinishAfter` = échéance, `CancelAfter` = échéance + délai ; à la date,
l'opérateur encaisse, que le client le veuille encore ou non ; avant la date, le registre
refuse (`tecNO_PERMISSION`). Ou le client *promet* et paie par un `Payment` ordinaire, ou ne
paie pas. **En XRP seulement** : ni RLUSD ni EURØP ne portent le drapeau d'émetteur qui
autorise l'escrow d'un jeton (`lsfAllowTrustLineLocking`, mesuré absent les 08/09 et
27/10/2026) ; le jour où un euro-jeton le porte, l'escrow tient des euros sans rien changer ici.

**Le défaut.** Échéance passée, rien reçu : le pool **écrit** le défaut (`AccountSet`
multisigné, mémo `dareskro/defaut`), garde le jeton comme trace de la cession, et c'est tout
ce que le registre lui permet : **aucune transaction ne permet à un créancier de prendre**. Le
recours est dans le contrat : ici le fournisseur rachète la créance (un `Payment` ordinaire,
qu'il aurait aussi pu refuser).

### Mesuré sur testnet, 01/11/2026, par le script (`run.log`, `compte_rendu.json`)

Nœud `wss://testnet.xrpl-labs.com`, huit comptes du robinet, échéances à 150 s (30 à 90 jours
en production), montants en XRP. Pool `r6YuFKaUWWUfk9g8ZpK8gnpcQp5rDrC8L` ; IA
`rLTdRYLudPWQBRivqSuE3TsxhPKSUpiVLG`, politique `rUiaEtdUn6hkxDHBApTPE7oUesCETmeuT1`,
opérateur `rHUM2GAE8SyokuhVKoZkqB1Rquhy6Hyzyi` ; fournisseur
`rpJsdAd1i1cFETyCHXpRetzSRs6AzVMtp8` ; clients `r4n6qUhL8AdUcjYtpqompiUv99NEAHBDUV` et
`r33U8FTBEmirxaRtHRg6CijkToJKbJWWUc`. Trois factures : F-001 (client 1, 50 XRP, avance 45,
acceptée, remboursement verrouillé), F-002 (client 1, 10 XRP, avance 9 : **refusée par la
politique de risque**, 45 + 9 = 54 XRP = 33,8 % du capital > 30 %), F-003 (client 2, 40 XRP,
avance 36, acceptée, jamais payée : **défaut**).

| Heure UTC | Étape | Résultat | Preuve |
|---|---|---|---|
| 20:57:10 | ouverture du compte du pool (réserve 3 XRP) | `tesSUCCESS` | [BC17889D…](https://testnet.xrpl.org/transactions/BC17889D686BB35CA20A0042CB3774400C912664F9B6A7505C33440B0C46BC5D) |
| 20:57:12 | SignerListSet 2-sur-3 (IA, politique de risque, opérateur) | `tesSUCCESS` | [E42DFD11…](https://testnet.xrpl.org/transactions/E42DFD117AC2FC6856918596E9DA4EBF5311E85E80CA9073CCC79EBE6F4B4F05) |
| 20:57:20 | clé maîtresse du pool désactivée | `tesSUCCESS` | [93BB5DF3…](https://testnet.xrpl.org/transactions/93BB5DF35EC9FDDB291481315E4DE05B896538EFBC67AA17D72CECE25F0F3F73) |
| 20:57:22 | prêteur A apporte 80 XRP au pool | `tesSUCCESS` | [85689C38…](https://testnet.xrpl.org/transactions/85689C381ABD3DB7D16448D0D25B6EACFB9289609C406545466ACF1C879C143C) |
| 20:57:31 | prêteur B apporte 80 XRP au pool | `tesSUCCESS` | [94149680…](https://testnet.xrpl.org/transactions/941496804D795763456130A82B75535B006F8C043DEC0DA49104B129E9C2835C) |
| 20:57:32 | F-2026-001 jeton de la facture émis par le fournisseur (MPTokenIssuanceCreate) | `tesSUCCESS` | [D8719C22…](https://testnet.xrpl.org/transactions/D8719C227BE4AF273C12AEF22BB722229DF72D24ECAF91A9282E23F2DFE13F30) |
| 20:57:41 | F-2026-001 analyse de l'IA ancrée (AccountSet, mémo sha256 ab01a36958c5…) | `tesSUCCESS` | [511B7764…](https://testnet.xrpl.org/transactions/511B7764E185B1F5A82E6C3D6F0B22B3B9510BADC4A34F6B8B7473A8D8C4EC53) |
| 20:57:50 | F-2026-001 le pool accepte le jeton (MPTokenAuthorize, 2/3) | `tesSUCCESS` | [7FB160CC…](https://testnet.xrpl.org/transactions/7FB160CCEA49AEC4E7067530CD0136BA086BA46D9315CA25D29183B9E0FFFB5A) |
| 20:57:51 | F-2026-001 créance cédée : 1 jeton fournisseur → pool | `tesSUCCESS` | [357FB2DD…](https://testnet.xrpl.org/transactions/357FB2DD6D54E5F5CF2FFFA96C8AA1C55093431294888E0EC2C174815B69EDA7) |
| 20:57:53 | F-2026-001 avance 45 XRP pool → fournisseur, signée 2/3 | `tesSUCCESS` | [1A46D683…](https://testnet.xrpl.org/transactions/1A46D683C6534E5CD9FDB191B16F86CD69584DA1453D9FA8EEFC10E45E6D33F5) |
| 20:58:00 | F-2026-001 remboursement verrouillé par le client : escrow 50 XRP → pool, libérable à l'échéance | `tesSUCCESS` | [1C750D3D…](https://testnet.xrpl.org/transactions/1C750D3D7D3BEFAC4AFA2F6D144BF7AB7260B66D5DD69F63D90D8E28898C5653) |
| 20:58:10 | F-2026-001 EscrowFinish par l'opérateur (avant l'échéance) | `tecNO_PERMISSION` | [FFED265B…](https://testnet.xrpl.org/transactions/FFED265B46B31CC12542E3E308FFB602D932ECB7E2DEF705A0A5D623E49D35E0) |
| 20:58:11 | F-2026-002 jeton de la facture émis par le fournisseur (MPTokenIssuanceCreate) | `tesSUCCESS` | [0907098E…](https://testnet.xrpl.org/transactions/0907098E10E8F992ABA290B125E8600383216EC8AD1FAB6794C919581C20D2E7) |
| 20:58:12 | F-2026-002 analyse de l'IA ancrée (AccountSet, mémo sha256 16ed7a71ea9a…) | `tesSUCCESS` | [6DAF9190…](https://testnet.xrpl.org/transactions/6DAF91903081971E80AE2922EA958C76278CE2B2C82637808343BAB4E556415C) |
|  | F-2026-002 avance 9 XRP pool → fournisseur, signée 1/3 | `tefBAD_QUORUM` | *refusé à la porte : Signatures provided do not meet the quorum.* |
| 20:58:20 | F-2026-002 le pool accepte le jeton (MPTokenAuthorize, 2/3) | `tesSUCCESS` | [5DC531D2…](https://testnet.xrpl.org/transactions/5DC531D212A8BE7095E3F433C2CB58AEBC5F8027885CECB8572F097883FFECEC) |
| 20:58:22 | F-2026-002 créance cédée : 1 jeton fournisseur → pool | `tesSUCCESS` | [2B36DD2D…](https://testnet.xrpl.org/transactions/2B36DD2DA610CE4487693171D533981AF93ED87547F1218F681DBB67D4566D8F) |
| 20:58:30 | F-2026-002 avance 9 XRP pool → fournisseur, signée 2/3 | `tesSUCCESS` | [3622B6D3…](https://testnet.xrpl.org/transactions/3622B6D3A0436875BCFFED1709F05AE56EF19ED493C45653A736F772E6E7C231) |
| 20:58:32 | F-2026-003 jeton de la facture émis par le fournisseur (MPTokenIssuanceCreate) | `tesSUCCESS` | [07299BE0…](https://testnet.xrpl.org/transactions/07299BE00ECCA1D6C005A48784DF8D4FDDDA7F39DBDE599A61CEBBFBC10FB61F) |
| 20:58:40 | F-2026-003 analyse de l'IA ancrée (AccountSet, mémo sha256 aaeb50e99c9a…) | `tesSUCCESS` | [1C88D9BF…](https://testnet.xrpl.org/transactions/1C88D9BFF23F74A18EB04B994F48019F1DE84F27FE24B47881C172F19B166CDB) |
| 20:58:42 | F-2026-003 le pool accepte le jeton (MPTokenAuthorize, 2/3) | `tesSUCCESS` | [4CD51313…](https://testnet.xrpl.org/transactions/4CD5131391DD9A06CD4BD86248F537EBE9C91F0DC3B38655B9099A3A27182CAE) |
| 20:58:51 | F-2026-003 créance cédée : 1 jeton fournisseur → pool | `tesSUCCESS` | [614FF446…](https://testnet.xrpl.org/transactions/614FF4461E7A93F3D894C5EFA975FE0FCF17115C61A6A4F58D911C3202B6FFDC) |
| 20:59:00 | F-2026-003 avance 36 XRP pool → fournisseur, signée 2/3 | `tesSUCCESS` | [3DF1D98A…](https://testnet.xrpl.org/transactions/3DF1D98AD89342A8401AB52B646A345458A8AC45669B517F3BA2456867AFCA41) |
| 21:00:12 | F-2026-001 EscrowFinish par l'opérateur (à l'échéance) | `tesSUCCESS` | [4A32AD5A…](https://testnet.xrpl.org/transactions/4A32AD5AFBD35D3F5EB70692531DD3C7A7698D3683E28B2E0D70EF8ACFDFCC0D) |
| 21:00:21 | F-2026-001 solde 4 XRP au fournisseur (frais 1 gardés par le pool), signé politique + opérateur | `tesSUCCESS` | [A76664E6…](https://testnet.xrpl.org/transactions/A76664E6A2238C6E5D81DAD3F7265D8DCD3E0025DD274DC10918DF38041C4EC9) |
| 21:00:30 | F-2026-001 jeton rendu à l'émetteur : créance éteinte (payée par le client à l'échéance) | `tesSUCCESS` | [0A09B83A…](https://testnet.xrpl.org/transactions/0A09B83AC6C2813BF238D3A222ADD3AD5DFEEC0402AE50DB09A775A56B1CBFCB) |
| 21:00:40 | F-2026-002 le client paie le pool par un Payment ordinaire (rien ne l'y forçait) | `tesSUCCESS` | [B99BE239…](https://testnet.xrpl.org/transactions/B99BE239CD01E5FBE17620A191BBE11375477DC9E91BD65C071888D2D0C3C3DF) |
| 21:00:42 | F-2026-002 solde 0.8 XRP au fournisseur | `tesSUCCESS` | [C4475C6B…](https://testnet.xrpl.org/transactions/C4475C6B5CB650089E6AC4BE71DA93846BDA875F2239B5E5A7F3CED477A315F9) |
| 21:00:50 | F-2026-002 jeton rendu à l'émetteur : créance éteinte (payée par le client) | `tesSUCCESS` | [84F3C516…](https://testnet.xrpl.org/transactions/84F3C516F557A7B65BBD71982E79159088391136B61F609DE399E69DDBAD5788) |
| 21:00:52 | F-2026-003 défaut constaté par le pool (AccountSet 2/3, mémo) | `tesSUCCESS` | [DAF3A7F0…](https://testnet.xrpl.org/transactions/DAF3A7F0FBF9DD08036750D5EA96EF9DFAB5BB208C11C721C62B91BF6571C995) |
| 21:01:00 | F-2026-003 le fournisseur rachète la créance : 36 XRP → pool | `tesSUCCESS` | [710F169F…](https://testnet.xrpl.org/transactions/710F169F80FEB974CA046C9172C33A76F007A250DC67FB2C53FF42A9C5F9122C) |
| 21:01:02 | F-2026-003 jeton rendu à l'émetteur : créance éteinte (rachetée par le fournisseur après défaut du client) | `tesSUCCESS` | [49B30548…](https://testnet.xrpl.org/transactions/49B305483152AE82BC9A23CE6A7B418081EA46B57F1486FE23D4A08682CB2EC9) |

Lecture. La ligne `tefBAD_QUORUM` est l'IA seule : le registre compte les signatures. La ligne
suivante est la **contre-épreuve** : IA + opérateur signent l'avance F-002 que la politique
avait refusée, et le registre paie (`tesSUCCESS`). Le refus de la politique de risque est le
refus **d'un signataire, pas du registre** ; dans cette version le plafond ne tient que par la
discipline de deux sièges sur trois. C'est exactement ce que la version 2 change. Soldes
finaux : pool 164,20 XRP (160 de capital + 1,2 de frais + 3 de réserve − frais de réseau),
fournisseur 158,80, client 1 40,00, client 2 100 (il n'a rien payé). Les analyses de l'IA sont
dans `sortie/analyses/F-2026-00*.json` ; chacune se rehache et se retrouve dans le mémo de son
ancrage.

### Mesuré depuis l'écran, 01/11/2026 (pupitre `app/`, cas « Invoice advance · pool 2/3 »)

`node service.mjs` (127.0.0.1:8783) tient les clés de test dans `cles/` (0600, ignoré par git)
et l'état public dans `etat.json`. Depuis le pupitre, en cliquant : création du pool, facture
P-001 (50 XRP) analysée, acceptée, avancée à 2/3, remboursement verrouillé par le client,
encaissement refusé avant la date puis fait à la date, solde au fournisseur, jeton rendu ;
facture P-002 (10 XRP, même client) analysée, **refusée** par la politique, tentative à une
signature refusée par le registre, puis **passage outre** à deux signatures (IA + opérateur,
la case « risk policy » étant grisée). Captures dans `sortie/captures/`. Pool
`rhc7g7H7c1UzSxdnJxjzcRM5rHWqRG9ERN`.

| Heure UTC | Étape | Résultat | Preuve |
|---|---|---|---|
| 21:04:20 | ouverture du compte du pool (réserve 3 XRP) | `tesSUCCESS` | [5574625D…](https://testnet.xrpl.org/transactions/5574625DEEE4E2EBA91283DCA62F978D34005A152D1AB13BCAD40431268BD5A8) |
| 21:04:22 | SignerListSet 2-sur-3 (IA, politique de risque, opérateur) | `tesSUCCESS` | [05FE5DF5…](https://testnet.xrpl.org/transactions/05FE5DF5B17714EBEA483F534E1F07A163A13D1D8BBB8EDF94EEFEEA93FABDE4) |
| 21:04:30 | clé maîtresse du pool désactivée | `tesSUCCESS` | [ACFBB6BB…](https://testnet.xrpl.org/transactions/ACFBB6BB36FC0231AFED11626005E10B0F1B184E099E79245FB17B29A8D0A4E0) |
| 21:04:40 | preteurA apporte 80 XRP | `tesSUCCESS` | [5EF85B5A…](https://testnet.xrpl.org/transactions/5EF85B5A297BF3E5186BFD6D421F50A6C2E381F26CFE5CADF2AFC7C3B659D05C) |
| 21:04:41 | preteurB apporte 80 XRP | `tesSUCCESS` | [35FF2135…](https://testnet.xrpl.org/transactions/35FF2135B7578EB370809A69594DFF85BD357F555C1BE37B25C0BD4B3BDF75BF) |
| 21:08:02 | P-2026-001 : jeton de la facture (MPTokenIssuanceCreate) 014FA1BECEB9B3C376A39431807AF6E0BD1571E70535E165 | `tesSUCCESS` | [CF46DD9A…](https://testnet.xrpl.org/transactions/CF46DD9A124FD91F9F7E76FF2BB2D1493747F923D9E0935D3B8DE6B8945747BB) |
|  | P-2026-001 : analyse de l'IA ancrée (sha256 cc7710c0f9e8…), recommande « avancer » | `tesSUCCESS` | [85DE3B2F…](https://testnet.xrpl.org/transactions/85DE3B2FFA35E975059A697D85837574BA293CB0E7D543289D655748D442F04C) |
| 21:08:30 | P-2026-001 : politique de risque — ACCEPTE | `signe` | *aucune transaction* |
| 21:09:32 | P-2026-001 : EscrowFinish avant l'échéance | `tecNO_PERMISSION` | [816828A8…](https://testnet.xrpl.org/transactions/816828A891E82DC6C6F95A471578207C74DF8AFF87A6687EFA57F9C494E0E4C4) |
| 21:08:50 | P-2026-001 : le pool accepte le jeton (2/3) | `tesSUCCESS` | [3627B8BD…](https://testnet.xrpl.org/transactions/3627B8BDE1E2B9076597E64EECBEC9C2214741CE21693E5E62EFFF8C61B76129) |
| 21:08:51 | P-2026-001 : créance cédée (1 jeton fournisseur → pool) | `tesSUCCESS` | [3735A51E…](https://testnet.xrpl.org/transactions/3735A51E8BB21203A6906419A44EEAB5CE523F70445D565A37FDEB9A27E5F076) |
| 21:09:00 | P-2026-001 : AVANCE 45 XRP, signée ia + politique | `tesSUCCESS` | [1BD70410…](https://testnet.xrpl.org/transactions/1BD70410BC6820EEDA005FA7C54DD931B6E7F3E8680F1D98008F1FA404FB7F86) |
| 21:09:21 | P-2026-001 : le client verrouille le remboursement (EscrowCreate) | `tesSUCCESS` | [C1A2DBEE…](https://testnet.xrpl.org/transactions/C1A2DBEE913F6CC20D2A30CD6903BBE0712662CB17377069EAB6921F79AEE9C4) |
| 21:14:10 | P-2026-001 : encaissement | `tesSUCCESS` | [8712573B…](https://testnet.xrpl.org/transactions/8712573BB61F3FC8F21AB58BEF744474417E9A8EC6FF180C364604CDA690D21C) |
| 21:14:21 | P-2026-001 : solde au fournisseur | `tesSUCCESS` | [4B5D17E1…](https://testnet.xrpl.org/transactions/4B5D17E152115A4B5935CA5014133F9F32F796477D34E5E49CC93C12219670BF) |
| 21:14:30 | P-2026-001 : jeton rendu : créance éteinte | `tesSUCCESS` | [BD945ECF…](https://testnet.xrpl.org/transactions/BD945ECF17FBFDDCCE2B77F4C592051B433AE7AA7A335C865F915527D19A67E3) |
| 21:10:01 | P-2026-002 : jeton de la facture (MPTokenIssuanceCreate) 014FA1C0CEB9B3C376A39431807AF6E0BD1571E70535E165 | `tesSUCCESS` | [D5571E4F…](https://testnet.xrpl.org/transactions/D5571E4F8E9F71DDA146E9B5792434CD1E14D43FBBB8038261420C8F6B74ECD7) |
|  | P-2026-002 : analyse de l'IA ancrée (sha256 6420bd64dde4…), recommande « avancer » | `tesSUCCESS` | [7AB2609A…](https://testnet.xrpl.org/transactions/7AB2609A02FC12D01408324C31F62D088432014CF49E664D081422C201454D13) |
| 21:10:40 | P-2026-002 : politique de risque — REFUSE : plafond de concentration : ce débiteur aurait 33.8 % du capital (54 / 160) > 30 % | `ne signe pas` | *aucune transaction* |
|  | P-2026-002 : tentative d'avance signée ia seulement | `tefBAD_QUORUM` | *aucune transaction* |
| 21:11:12 | P-2026-002 : le pool accepte le jeton (2/3) | `tesSUCCESS` | [AA346744…](https://testnet.xrpl.org/transactions/AA346744408F2E3FA8783BDA80482C121ADC25EA1DA4F51440C00D799C9042F1) |
| 21:11:21 | P-2026-002 : créance cédée (1 jeton fournisseur → pool) | `tesSUCCESS` | [C1D48336…](https://testnet.xrpl.org/transactions/C1D483360226D549923D421E8BEF363464A79577700C687992D8AF7099AFB02D) |
| 21:11:30 | P-2026-002 : AVANCE 9 XRP, signée ia + operateur — PASSAGE OUTRE la politique | `tesSUCCESS` | [D0568DB1…](https://testnet.xrpl.org/transactions/D0568DB1562494CE3FB2D537EE66AF237B318990204DBFB2E924FD615CD5A68F) |

Ce que l'écran ne fait pas encore : l'opérateur signe avec une clé de test que le service
détient ; sur mainnet il signerait sur son Ledger (la multisignature XRPL depuis l'app XRP n'a
pas été essayée) et les deux autres sièges tourneraient sur leurs propres machines, le service
n'assemblant que le blob.

## Version 2 — XLS-65 (coffre) + XLS-66 (prêt), sur devnet

**État des amendements, mesuré le 01/11/2026 par la commande `feature`.** Devnet
(`wss://s.devnet.rippletest.net:51233`, rippled 3.4.1) : `SingleAssetVault`, `LendingProtocol`
et `LendingProtocolV1_1` **activés**. Mainnet (`wss://xrplcluster.com`, rippled 3.4.1) :
les trois `supported` mais **non activés** ; décompte des votes (xrpscan, même jour) :
SingleAssetVault **21 / 35** validateurs, LendingProtocol **19 / 35**, LendingProtocolV1_1
**19 / 35**, seuil 28 ; aucune date. xrpl.js 5.3.0 encode toutes les transactions, y compris la
contre-signature de l'emprunteur (`signLoanSetByCounterparty`).

**Ce qui a été construit.** Le coffre (`VaultCreate`, actif XRP, public, `Data` = empreinte de
la charte du pool) ; deux prêteurs y déposent 80 + 80 XRP et reçoivent des parts (un MPT frappé
par le registre) ; dareskro se déclare courtier (`LoanBrokerSet`, `DebtMaximum` 48 XRP = 30 %
de 160, couverture minimale, frais de gestion) et dépose 10 XRP de couverture première perte ;
un prêt de 45 XRP au fournisseur (`LoanSet`, `Data` = empreinte de la facture, une échéance,
signé par le courtier **puis contresigné par l'emprunteur**) ; un second prêt de 9 XRP qui
porterait la dette à 54 ; le remboursement (`LoanPay`) ; un troisième prêt de 36 XRP jamais
remboursé, mis en défaut (`LoanManage tfLoanDefault`) après échéance + grâce ; la phase de
rachat où les prêteurs reprennent ce qui reste (`VaultWithdraw`).

| Heure UTC | Étape | Résultat | Preuve |
|---|---|---|---|
| 21:17:11 | VaultCreate (XRP, public, fermé : souscription 40 s puis investissement 420 s, Data = empreinte de la charte du pool) | `tesSUCCESS` | [56773F9F…](https://devnet.xrpl.org/transactions/56773F9FF49D35AB8E39876AE6321E1104BCACE01C72ACD3D0D8699D58D6D328) |
| 21:17:20 | prêteur A dépose 80 XRP dans le coffre (VaultDeposit) | `tesSUCCESS` | [426D7FD7…](https://devnet.xrpl.org/transactions/426D7FD78AADD25AC7754D85A38D706C739050E062C0AF397EA68029A69133EB) |
| 21:17:22 | prêteur B dépose 80 XRP dans le coffre (VaultDeposit) | `tesSUCCESS` | [C6A14BF0…](https://devnet.xrpl.org/transactions/C6A14BF069ECBA764DCBD976A3B1833428B578894E6C2851F982B5A4B8F09A1A) |
| 21:17:31 | LoanBrokerSet : dareskro courtier, DebtMaximum 48 XRP imposé par le registre | `tesSUCCESS` | [3565AE94…](https://devnet.xrpl.org/transactions/3565AE94E489965970B34993B7299E56F58BB5E870C8315DFC6D54F106CEA736) |
| 21:17:41 | LoanBrokerCoverDeposit : 10 XRP de couverture première perte, apportés par dareskro | `tesSUCCESS` | [4DE29CF3…](https://devnet.xrpl.org/transactions/4DE29CF36EAA32784B911B20C337750CB8D5BB7CBE66643907DA149A8AEE9182) |
| 21:18:00 | prêteur B tente un dépôt pendant la phase d'investissement | `tecEXPIRED` | [FFEA78AA…](https://devnet.xrpl.org/transactions/FFEA78AA1F18815F207786C0F1FEB60C9C0B9F44489ECC4324A4C1DB3B751728) |
| 21:18:10 | F-2026-001 LoanSet 45 XRP, signé courtier + contresigné fournisseur | `tesSUCCESS` | [BEFF1D00…](https://devnet.xrpl.org/transactions/BEFF1D007381D28D61EF7B061F80EFEBC0D297071C69802CBE8F7E384BAD8681) |
| 21:18:12 | un étranger tente LoanPay sur le prêt 1 | `tecNO_PERMISSION` | [0BF26A3C…](https://devnet.xrpl.org/transactions/0BF26A3CD9B5DC5A52CC3048A250639F74F406E3C3D6A887B2E0F234BD9E6CDC) |
| 21:18:21 | F-2026-002 LoanSet 9 XRP : 45 + 9 = 54 > DebtMaximum 48 | `tecLIMIT_EXCEEDED` | [A1C24C3E…](https://devnet.xrpl.org/transactions/A1C24C3EBDB76A9C43DAC52B6CC7EC83AE8DE0FEB857137C4BF3B700F950D859) |
| 21:18:30 | F-2026-001 LoanPay avec tfLoanFullPayment sur un prêt à une seule échéance | `tecKILLED` | [97CEB758…](https://devnet.xrpl.org/transactions/97CEB75839699043C50D95105D89E8E71FDDCAF6D317D8AA0D7B155FBC719507) |
| 21:18:32 | F-2026-001 LoanPay régulier 45.000001 XRP (échéance unique, dû 45000000.25746131506 drops) | `tesSUCCESS` | [E77468AF…](https://devnet.xrpl.org/transactions/E77468AF83879D69D27CBF3F34007AFEED2FA12BACFB21BC6A55BEA491E86597) |
| 21:18:41 | F-2026-003 LoanSet 36 XRP, signé courtier + contresigné fournisseur | `tesSUCCESS` | [CB36CDEB…](https://devnet.xrpl.org/transactions/CB36CDEB026405B1985EDD803147E2A700A9AB19983CDB3FC66336DA6EAD53DB) |
| 21:18:50 | LoanManage défaut AVANT l'échéance | `tecTOO_SOON` | [28405135…](https://devnet.xrpl.org/transactions/28405135794DFDF0A281580F5F713CD65B729464A31C4BB241B89BF600FA9300) |
| 21:21:40 | LoanManage tfLoanDefault après échéance + grâce | `tesSUCCESS` | [68D2D637…](https://devnet.xrpl.org/transactions/68D2D637FE5389BAA36EBD56D096D486A44992592EE27B52E7776DDA61EAC357) |
| 21:21:42 | prêteur A tente un retrait pendant la phase d'investissement | `tecTOO_SOON` | [A4027106…](https://devnet.xrpl.org/transactions/A40271061577C17DF00BF18C8D34BE517F6BD492FDF47780A035BBB6B25D236F) |
| 21:25:00 | prêteur A retire ses 80000000 parts (VaultWithdraw, phase de rachat) | `tesSUCCESS` | [7AFE1B72…](https://devnet.xrpl.org/transactions/7AFE1B7241B7E4C6EBB72F7D82D9BAC7738CACA41D060F1FDEBD4C6D32FF0A21) |
| 21:25:02 | prêteur B retire ses 80000000 parts (VaultWithdraw, phase de rachat) | `tesSUCCESS` | [F20CEAEE…](https://devnet.xrpl.org/transactions/F20CEAEE498E3AF45730D70F986437836ACD550F6C02C63ACCE8B78F8091B248) |

Lecture, face à la version 1 :

- le **plafond** : `LoanSet` 9 XRP → `tecLIMIT_EXCEEDED`. C'est le registre qui refuse,
  depuis l'objet `LoanBroker` ; il n'existe pas de seconde signature qui passe outre. En
  version 1 la même avance était payée par IA + opérateur ;
- la **date** : `LoanManage` défaut avant échéance + grâce → `tecTOO_SOON` ; après →
  `tesSUCCESS`, et le registre réalise la perte lui-même : actif du coffre 160,000001 →
  124,001801 XRP, couverture du courtier 10 → 9,9982 XRP. En version 1 le pool ne pouvait
  qu'écrire le défaut ;
- **qui rembourse** : un étranger `LoanPay` → `tecNO_PERMISSION` : seul l'emprunteur paie
  son prêt. En version 1 le client final payait directement le pool. Le client final n'existe
  pas dans XLS-66 : l'emprunteur est le fournisseur, et c'est à lui de faire suivre le paiement
  du client (ou de lui donner le pool comme compte à payer, ce que le registre ne lie pas) ;
- **les prêteurs** : parts du coffre, phases de souscription (dépôt), d'investissement (ni
  dépôt ni retrait : `tecEXPIRED`, `tecTOO_SOON` mesurés) et de rachat ; à la fin chacun
  reprend 62,00 XRP sur 80 : la perte de 36 XRP est partagée au prorata, la couverture du
  courtier n'en a absorbé que 0,0018 avec `CoverRateLiquidation` 500 — la sémantique de ces
  taux (dix-millièmes de pour cent) est à lire dans la spécification avant tout usage réel.

**Ce qu'il a fallu apprendre en route** (les essais sont dans `sortie/run_devnet_essai*.log`) :
avec `LendingProtocolV1_1`, un courtier ne s'attache qu'à un coffre **fermé** (`VaultKind: 1`,
`SubscriptionDate`, `RedemptionDate` au moins 180 s plus tard ; coffre ouvert →
`tecNO_PERMISSION`) ; un prêt doit finir 60 s avant la date de rachat ; `PaymentInterval`
≥ 60 s et la grâce entre 60 s et l'intervalle ; les montants de `LoanPay` sont en **drops
entiers** alors que le prêt porte des fractions de drop d'intérêt (arrondir au-dessus) ;
`tfLoanFullPayment` est refusé (`tecKILLED`) sur un prêt à une seule échéance, dont le dernier
paiement doit être régulier ; les champs à zéro (`DebtTotal`, `AssetsTotal`) sont omis des
objets. Source lue : `src/libxrpl/tx/transactors/lending/*.cpp` de rippled (branche develop).

**Ce que cette version ne fait pas.** Rien sur mainnet, et rien n'y est possible avant
l'activation. Pas de pupitre : le script seul. Pas de modèle de taux ni de frais réfléchi (les
valeurs sont là pour que les transactions passent). Pas de permissioned domain (le coffre est
public : n'importe qui peut y déposer).

## Qui détient quoi

| | Version 1 | Version 2 |
|---|---|---|
| Les prêteurs | ont viré au pool ; ne peuvent reprendre qu'avec 2 signatures sur 3 | détiennent des parts du coffre ; reprennent seuls en phase de rachat |
| Le pool / le coffre | un compte, clé maîtresse désactivée | un pseudo-compte sans clé |
| L'IA | une clé qui ne vaut rien seule ; son analyse ancrée | hors registre (propose au courtier) |
| La politique de risque | une clé qui ne vaut rien seule ; ses limites publiées | remplacée par `DebtMaximum` pour la concentration ; le reste (avance ≤ 90 %, échéance) reste hors registre |
| L'opérateur / dareskro | une clé qui ne vaut rien seule | courtier : sa couverture première perte, ses frais, le pouvoir d'accorder (avec l'emprunteur) et de déclarer le défaut |
| Le fournisseur | le jeton de sa facture jusqu'à la cession ; l'avance ; le solde | emprunteur : le principal, la dette |
| Le client final | rien ; paie le pool (escrow ou virement) | n'existe pas pour le registre |

## Les limites honnêtes

- **C'est du prêt.** Avancer le montant d'une facture contre cession de la créance, c'est de
  l'affacturage, une opération de crédit au sens du code monétaire et financier (art.
  L. 313-1) ; en France elle est réservée aux établissements de crédit et sociétés de
  financement, hors exceptions étroites (prêts interentreprises de l'art. L. 511-6 3 bis,
  financement participatif, cessions Dailly par une banque). Un pool de prêteurs qui n'est pas
  agréé, ou dareskro qui le « courtise », tombe sous l'une ou l'autre qualification, ou sous
  celle d'intermédiaire ; **l'agrément n'est pas tranché** et rien ici ne vaut avis. Même
  question que pour le dépôt de garantie, en plus lourd : avocat avant le premier euro réel.
- **La cession de créance** est un acte juridique (cession civile notifiée, subrogation, ou
  Dailly) ; le jeton n'en est que la trace. Sans l'acte, le pool n'a aucun droit sur le client.
- **LCB-FT et connaissance client** : prêteurs, fournisseur, client final. Rien n'est fait.
- **Stand-ins** : montants en XRP pour des euros ; l'IA est un script ; les clés des trois
  sièges et des contreparties sont des comptes du robinet (script) ou des fichiers 0600 que le
  service détient (écran) ; en réel, un siège = une machine ; l'opérateur = un Ledger.
- **Ce que le registre ne sait pas en version 1** : le plafond. Le prouver était le but de la
  contre-épreuve. Publier les limites de la politique (leur hash dans le mémo de création du
  pool) et les faire signer par une machine que dareskro ne contrôle pas seul serait le minimum.
- **Mainnet** : jamais ici ; seulement sur décision explicite, et pour la version 2, pas avant
  l'activation des amendements.

## Lancer

```
cd facture && npm install
node politique.mjs                    # les règles, 14 auto-vérifications
node demo_avance_facture.mjs          # ≈ 6 min sur testnet, 8 comptes du robinet, aucune clé écrite
node devnet_xls65_66.mjs              # ≈ 9 min sur devnet, 5 comptes du robinet
node service.mjs                      # 127.0.0.1:8783, puis le pupitre : cd ../app && npm run dev, cas « Invoice advance »
node tableaux.mjs testnet|ecran|devnet
```

`XRPL_WSS` change le nœud testnet, `XRPL_DEVNET` le nœud devnet, `FACTURE_PORT` le port du
service. Le robinet refuse les demandes parallèles (HTTP 429) : les scripts les font une à une.
