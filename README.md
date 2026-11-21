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

Limites connues de l'étape 1 : les groupes de calques d'un PSD sont mis à plat dans la liste, les masques de fusion sont appliqués aux pixels, les calques de réglage sont ignorés.

## Étape 2 — les outils de base (v0.2.0)

- Pinceau et gomme : taille, dureté, opacité, flux, pression du stylet (taille et / ou opacité), trait droit avec Maj, `[` `]` pour la taille, chiffres pour l'opacité
- Couleurs de premier plan et d'arrière-plan (X : inverser, D : noir et blanc), pipette (Alt : arrière-plan ; Alt+clic au pinceau)
- Pot de peinture : tolérance, pixels contigus, tous les calques
- Dégradé : linéaire, radial, réfléchi, vers l'arrière-plan ou vers le transparent
- Formes : rectangle, rectangle arrondi, ellipse, ligne, remplissage et contour (chaque forme sur son calque)
- Texte : calques de texte modifiables (police, taille, couleur, gras, italique, alignement, interligne), aperçu en direct
- Recadrage : poignées, proportions (1:1, 4:3, 16:9, story…), suppression ou non des pixels recadrés
- Édition : remplir avec le premier plan / l'arrière-plan, effacer le calque
- Historique de la peinture par zones modifiées : l'annulation reste illimitée sans saturer la mémoire

## Feuille de route

1. Le socle ✔
2. Outils de base : pinceau (pression du stylet), gomme, pot de peinture, dégradé, texte, formes, pipette, recadrage ✔
3. Sélections et masques : rectangle, lasso, baguette magique, masques de calque, transformation libre, groupes
4. Réglages et filtres : niveaux, courbes, teinte / saturation, calques de réglage, flou, netteté
5. Outils « pro » : tampon, correcteur, fluidité, styles de calque, objets dynamiques
6. IA locale : détourage, sélection d'objet, gomme magique, agrandissement, remplissage intelligent

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
| `js/tools.js` | Outils : pinceau, gomme, pipette, pot, dégradé, formes, texte, recadrage |
| `js/paint.js` | Moteur de peinture, remplissage, dégradés, rendu du texte et des formes |
| `js/panels.js` | Panneaux Calques, Historique, outils, onglets |
| `js/io.js` | Ouverture et enregistrement des fichiers |
| `vendor/ag-psd.min.js` | Lecture / écriture des PSD (bibliothèque ag-psd, licence MIT) |
