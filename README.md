# Enluminure

L'atelier d'images d'Anamnesis · CSC : un éditeur d'images façon Photoshop, qui tourne dans le navigateur (PC, tablette, iPhone) et s'installe comme une appli.
Tout se passe sur l'appareil : aucune image n'est envoyée sur internet.

## Étape 1 — le socle

- Documents en onglets : nouveau document (modèles), ouverture JPG / PNG / WebP / GIF / PSD, glisser-déposer, coller (Ctrl+V)
- Calques : ajout, duplication, suppression, renommage, réorganisation par glisser, visibilité, opacité, 17 modes de fusion, masque d'écrêtage, fusion vers le bas, fusion des visibles, aplatir
- Historique illimité (annuler / rétablir + panneau Historique), les plus anciennes étapes ne sont oubliées que si la mémoire manque
- Zoom (molette, pincement à deux doigts, 1 % à 6 400 %, grille des pixels), main, outil Déplacer (flèches : 1 px, Maj : 10 px)
- Image : taille de l'image (rééchantillonnage de qualité), taille de la zone de travail (ancrage), rotations, symétries ; transformations du calque
- Enregistrement en .psd avec les calques, export JPG / PNG / WebP (qualité, taille)
- Raccourcis clavier de Photoshop

Limite connue : quelques réglages Photoshop rares (mélangeur de couches, correction sélective, table de correspondance) sont ignorés à l'ouverture d'un PSD.

## Étape 2 — les outils de base

- Pinceau et gomme : taille, dureté, opacité, flux, pression du stylet (taille et / ou opacité), trait droit avec Maj, `[` `]` pour la taille, chiffres pour l'opacité
- Couleurs de premier plan et d'arrière-plan (X : inverser, D : noir et blanc), pipette (Alt : arrière-plan ; Alt+clic au pinceau)
- Pot de peinture : tolérance, pixels contigus, tous les calques
- Dégradé : linéaire, radial, réfléchi, vers l'arrière-plan ou vers le transparent
- Formes : rectangle, rectangle arrondi, ellipse, ligne, remplissage et contour (chaque forme sur son calque)
- Texte : calques de texte modifiables (police, taille, couleur, gras, italique, alignement, interligne), aperçu en direct
- Recadrage : poignées, proportions (1:1, 4:3, 16:9, story…), suppression ou non des pixels recadrés
- Édition : remplir avec le premier plan / l'arrière-plan, effacer le calque
- Historique de la peinture par zones modifiées : l'annulation reste illimitée sans saturer la mémoire

## Étape 3 — sélections, masques, transformation, groupes

- Sélections : rectangle, ellipse, lasso, lasso polygonal, baguette magique (tolérance, contigu, tous les calques)
- Modes nouvelle / ajouter (Maj) / soustraire (Alt) / intersection (Maj+Alt), contour progressif, pointillés animés
- Menu Sélection : tout sélectionner, désélectionner, resélectionner, intervertir, contour progressif, dilater, contracter, pixels du calque, depuis le masque
- Les outils de peinture, le pot, le dégradé, remplir et effacer restent dans la sélection ; couper / copier la sélection, calque par copie / par coupe, recadrer sur la sélection
- L'outil Déplacer déplace les pixels sélectionnés ; glisser dans une sélection avec un outil de sélection déplace son contour
- Masques de fusion sur les calques et les groupes : tout faire apparaître / tout masquer / depuis la sélection, peinture en niveaux de gris (pinceau, gomme, dégradé, pot), désactiver, appliquer, supprimer
- Transformation manuelle (Ctrl+T) : déplacer, mettre à l'échelle (proportions), rotation (Maj : 15°), symétries, valeurs numériques, sur le calque ou sur la sélection
- Groupes de calques : créer, grouper / dissocier, replier, glisser des calques dedans, opacité / mode / masque du groupe, fusionner un groupe, sélection multiple de calques
- PSD : les groupes et les masques sont lus et enregistrés

## Étape 4 — réglages et filtres (v0.4.0)

Tout est calculé par la carte graphique (WebGL), par tuiles pour les grandes images.

- Réglages (Image > Réglages), avec aperçu en direct et limités à la sélection : luminosité/contraste, niveaux (histogramme, auto), courbes (par canal), exposition, vibrance, teinte/saturation (et « redéfinir »), balance des couleurs, noir et blanc (paramètres prédéfinis, teinte), filtre photo, négatif, postérisation, seuil, courbe de transfert de dégradé
- Commandes rapides : niveaux, contraste et couleur automatiques, désaturation, négatif (aussi sur un masque)
- Calques de réglage non destructifs : modifiables à tout moment (double-clic sur la vignette), avec masque, opacité, mode de fusion, écrêtage ; lus et enregistrés en PSD
- Filtres (menu Filtre) : flou gaussien, flou directionnel, accentuation, ajout de bruit, réduction du bruit, mosaïque, vignettage ; Dernier filtre (Ctrl+F)

## Étape 5 — outils « pro » (v0.5.0)

- Correcteur (J) : mode localisé (on peint sur le défaut, la zone voisine qui se raccorde le mieux est trouvée toute seule) ou avec source (Alt+clic) ; les couleurs et la lumière sont raccordées au pourtour
- Tampon de duplication (S) : Alt+clic pour la source (au doigt : bouton « Choisir la source »), mode aligné, prélèvement sur le calque actif ou sur tous les calques (pratique sur un calque vide)
- Fluidité (Ctrl+Maj+X) : déformer, reconstruire, contracter, dilater, tourbillon, taille et force, défaire geste par geste ; aperçu rapide puis application en pleine résolution, limitée à la sélection
- Styles de calque (bouton fx) : ombre portée, ombre interne, lueur externe et interne, biseautage et estampage, contour, incrustation couleur et de dégradé, opacité du fond ; aperçu en direct, copier / coller / masquer / pixelliser le style ; lus et enregistrés en PSD
- Objets dynamiques : transformations sans perte (on repart toujours de l'image d'origine), filtres et réglages dynamiques modifiables, masquables et supprimables à tout moment (affichés sous le calque) ; « Pixelliser » pour revenir à un calque normal

Limite connue : dans un .psd, les objets dynamiques sont enregistrés comme calques normaux.

## Étape 6 — IA locale (v0.6.0)

Les modèles d'IA tournent **dans le navigateur, sur l'appareil** : sur la carte graphique quand elle est disponible (WebGPU — la RTX du PC, la puce de l'iPhone), sinon sur le processeur. Chaque modèle est téléchargé une seule fois depuis Hugging Face, puis reste sur l'appareil et fonctionne hors connexion. **Les images ne quittent jamais l'appareil.**

- Sélection > Sujet : sélectionne le sujet principal de la photo
- Calque > Supprimer l'arrière-plan : ajoute un masque de fusion autour du sujet (rien n'est effacé, le masque se retouche au pinceau)
- Outil Sélection d'objet (Maj+W) : un clic sur un objet, ou un cadre autour ; Maj ajoute, Alt retire
- Outil Suppression — gomme magique (Maj+J) : on peint sur ce qui doit disparaître, l'IA le remplace par le décor
- Édition > Remplissage d'après le contenu (Maj+Retour arrière) : remplace le contenu de la sélection
- Image > Agrandir avec l'IA (×2, ×4) : le résultat s'ouvre dans un nouvel onglet, l'original n'est pas modifié
- Aide > IA locale : liste des modèles, place occupée, tout télécharger pour le hors-connexion, choix carte graphique / processeur

| Fonction | Modèle | Licence | Taille |
|---|---|---|---|
| Sujet, arrière-plan | RMBG 1.4 (BRIA AI) | usage personnel, non commercial | 44 à 176 Mo |
| Sélection d'objet | SAM 2.1 tiny (Meta), sinon SlimSAM | Apache 2.0 | ≈ 155 Mo |
| Suppression, remplissage | MI-GAN (Picsart AI Research) | MIT | 28 Mo |
| Agrandissement | Real-ESRGAN ×4 (Xintao Wang) | BSD-3 | 67 Mo |

Moteur : ONNX Runtime Web (MIT), fourni dans `vendor/ort/`, et transformers.js 4.3.2 (Apache 2.0), chargé une fois depuis jsDelivr puis gardé pour le hors-connexion.

## Version 0.6.1 — grande vérification

Toutes les fonctions ont été repassées une par une (menus, outils, raccourcis, souris, doigt, fichiers), avec des corrections :

- Après une rotation ou une symétrie, le pinceau, la gomme et les autres outils dessinaient au mauvais endroit : corrigé
- Petits écrans d'ordinateur : tous les outils, les deux couleurs et la corbeille des calques restent visibles (les outils se rangent sur plusieurs colonnes) ; la barre d'options reste sur une seule ligne (elle défile si l'écran est étroit), donc l'image ne saute plus quand on change d'outil
- L'image reste bien cadrée quand la fenêtre change de taille ou quand on tourne l'appareil
- Les raccourcis clavier continuent de fonctionner après avoir touché un curseur, une case ou une liste
- Téléphone : boutons Valider / Annuler toujours visibles, menu rangé par rubriques qui se déplient, les fenêtres de réglage laissent voir l'image, tous les outils et les couleurs tiennent sur deux rangées
- Tactile : le premier appui juste après un trait n'est plus ignoré
- Copier / coller fonctionne même quand le navigateur refuse l'accès au presse-papiers ; « Copier » confirme tout de suite, même sur une grande image
- Une lettre tapée par erreur dans une case de chiffres ne remet plus la valeur à 1
- Une photo tout juste ouverte n'est plus marquée « modifiée »
- Sans accélération graphique, les réglages de couleur fonctionnent quand même
- Si l'appli ne démarre pas, un bouton « Recharger l'appli » apparaît ; un message s'affiche quand un problème survient

Non vérifié sur de vrais appareils : Safari (iPhone, iPad, Mac) et Firefox.

## Version 0.6.2 — thème clair

L'appli s'ouvre maintenant en clair, aux couleurs du parchemin. Le fond noir reste disponible : Affichage › Thème sombre. Le choix est gardé sur l'appareil.

## Feuille de route

1. Le socle ✔
2. Outils de base : pinceau (pression du stylet), gomme, pot de peinture, dégradé, texte, formes, pipette, recadrage ✔
3. Sélections et masques : rectangle, lasso, baguette magique, masques de calque, transformation libre, groupes ✔
4. Réglages et filtres : niveaux, courbes, teinte / saturation, calques de réglage, flou, netteté ✔
5. Outils « pro » : tampon, correcteur, fluidité, styles de calque, objets dynamiques ✔
6. IA locale : détourage, sélection d'objet, gomme magique, agrandissement, remplissage intelligent ✔

## Mettre en ligne sur GitHub Pages

1. Créer un dépôt (par exemple `enluminure`) et y déposer tout le contenu de ce dossier.
2. Settings → Pages → Branch `main`, dossier `/ (root)` → Save.
3. Ouvrir l'adresse donnée, puis « Installer » (PC) ou Partager → « Sur l'écran d'accueil » (iPhone).

Aucune compilation : ce sont des fichiers HTML, CSS et JavaScript prêts à l'emploi.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `index.html`, `css/app.css` | Interface |
| `js/main.js` | Application : menus, actions, raccourcis, fenêtres |
| `js/document.js` | Document et historique (annuler / rétablir, mémoire) |
| `js/ops.js` | Opérations sur les calques et l'image |
| `js/render.js` | Composition des calques (modes de fusion, écrêtage) |
| `js/view.js` | Zone de travail : affichage, zoom, souris, doigts |
| `js/tools.js` | Outils : pinceau, gomme, correcteur, tampon, pipette, pot, dégradé, formes, texte, recadrage |
| `js/paint.js` | Moteur de peinture, remplissage, dégradés, rendu du texte et des formes |
| `js/selection.js` | Sélections : création, combinaisons, contour progressif, pointillés |
| `js/tree.js` | Groupes de calques : arborescence et réorganisation |
| `js/gl.js` | Moteur graphique (WebGL) : passes de calcul, tuiles |
| `js/adjust.js` | Réglages et leurs fenêtres (niveaux, courbes…) |
| `js/filters.js` | Filtres (flous, accentuation, bruit…) |
| `js/styles.js`, `js/fxdialog.js` | Styles de calque (effets) et leur fenêtre |
| `js/liquify.js` | Fluidité |
| `js/smart.js` | Objets dynamiques et filtres dynamiques |
| `js/ai.js`, `js/aiui.js` | IA locale : moteur, modèles, et leurs fonctions dans l'appli |
| `vendor/ort/` | Moteur d'IA (ONNX Runtime Web) |
| `js/panels.js` | Panneaux Calques, Historique, outils, onglets |
| `js/io.js` | Ouverture et enregistrement des fichiers |
| `vendor/ag-psd.min.js` | Lecture / écriture des PSD (bibliothèque ag-psd, licence MIT) |
