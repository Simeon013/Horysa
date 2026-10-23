# Horysa

Guide mobile-first consacré à la découverte du Bénin. La première sélection porte sur Cotonou ; les données sont structurées pour accueillir d’autres villes.

## Lancer l’application

### Windows

Double-cliquer sur `start-horysa.bat`. Le script lance un petit serveur local et ouvre l’application dans le navigateur. Fermer la fenêtre du serveur pour arrêter la démo.

### Autre système

Depuis ce dossier, lancer `python -m http.server 4173`, puis ouvrir <http://localhost:4173>.

La première ouverture demande une connexion Internet. Le service worker met ensuite en cache l’interface ; la carte et les liens externes demandent toujours Internet. Sur un navigateur compatible, Horysa peut être installée comme application. Sans compte, les favoris, balades et sorties sont conservés sur l’appareil. Une fois Supabase configuré, ils sont synchronisés au compte après connexion par lien e-mail.

## Fonctions disponibles

- Navigation entre Explorer, lieux, carte, événements, carnet, agenda, histoires et contributions.
- Recherche par nom, thème ou quartier, avec raccourci `Ctrl/Cmd + K`.
- Filtres thématiques : histoire, art, culture, nature et littoral.
- Fiches de lieu avec informations pratiques, source et lien cartographique.
- Carte OpenStreetMap interactive, filtres, sélection de repères et géolocalisation facultative.
- Idées de balades qui regroupent des arrêts et les positionnent sur la carte. L’ordre est indicatif ; le tracé routier n’est pas calculé.
- Création et modification de balades personnelles, réorganisation des étapes, enregistrement local, suppression, affichage ordonné sur la carte et préremplissage de l’agenda.
- Carnet de lieux favoris conservé sur l’appareil, avec export des données personnelles.
- Agenda personnel permettant d’ajouter, consulter et supprimer une sortie avec date, heure, lieu et note.
- Export des sorties au format `.ics`, importable dans un calendrier (durée par défaut : une heure ; les horaires sont interprétés en heure du Bénin).
- Installation comme application web progressive (PWA) et mise en cache de l’interface pour une consultation hors connexion après le premier chargement.
- Récits courts sur l’histoire, l’art et les paysages de Cotonou.
- Interface responsive pour ordinateur et téléphone.

## Données et limites

Les fiches sont une sélection éditoriale à partir de sources publiques. Les propositions de lieux et d’événements sont modérées avant publication. Aucun flux d’événements externe n’est configuré pour le moment : Horysa n’affiche pas de faux contenu temps réel. Les horaires et tarifs non confirmés sont indiqués comme à vérifier. Les points marqués « position indicative » sont approximatifs ; le Mur Graffé du Port est recherché par nom car sa position précise n’a pas été établie dans cette version. Les liens de navigation ouvrent OpenStreetMap.

## Activer le service en ligne

Le dossier `supabase/migrations/202610230001_horysa_service.sql` contient le schéma sécurisé pour le catalogue public, les propositions en attente, les données privées de chaque compte, la modération et la suppression de compte. Il applique des règles RLS et ne requiert aucune clé secrète côté navigateur.

1. Créer un projet Supabase gratuit dans la région `eu-west-3` lorsque l’organisation dispose d’une place disponible. Aucun projet existant n’a été modifié.
2. Exécuter la migration dans l’éditeur SQL Supabase.
3. Régler l’URL du site et l’URL de redirection d’authentification sur l’adresse GitHub Pages publiée.
4. Renseigner l’URL du projet et sa clé **publishable** dans `supabase-config.js`. Cette clé est publique et doit rester protégée par les règles RLS; ne jamais y mettre une clé `secret` ou `service_role`.
5. Créer un compte administrateur par lien e-mail, puis dans l’éditeur SQL ajouter son identifiant utilisateur à `private.admins` :

   ```sql
   insert into private.admins (user_id)
   select id from auth.users where lower(email) = lower('ADRESSE_ADMIN');
   ```

L’organisation Supabase connectée avait déjà deux projets actifs sur son quota gratuit au moment de la mise en place. La synchronisation en ligne reste donc désactivée jusqu’à ce qu’une place gratuite soit disponible. Les deux projets existants n’ont pas été touchés et aucune dépense n’a été autorisée.

## Publication GitHub Pages

Le workflow `.github/workflows/pages.yml` publie automatiquement le site à chaque mise à jour de `main`. Pour le plan GitHub gratuit, le dépôt doit être public. Dans les paramètres du dépôt, activer Pages avec la source « GitHub Actions ».

Les fonds de carte standard OpenStreetMap sont chargés uniquement pour la zone affichée et portent leur attribution visible. L’usage en production nécessiterait de choisir un fournisseur de cartes adapté au trafic et à ses conditions d’utilisation.

## Sources principales

- [Bénin Tourisme — Cotonou](https://benintourisme.bj/villes/cotonou/)
- [Bénin Tourisme — Esplanade de l’Amazone](https://benintourisme.bj/destinations/lesplanade-de-lamazone/)
- [Site officiel de l’Esplanade — informations pratiques](https://amazone.bj/visiter/informations-pratiques/)
- [Gouvernement du Bénin — Monument Bio Guera](https://www.gouv.bj/attraction/monument-guera/)
- [Bénin Tourisme — Mur Graffé du Port](https://benintourisme.bj/destinations/le-mur-graffe-du-port/)
- [Bénin Tourisme — Face à l’Atlantique](https://benintourisme.bj/experiences/face-a-latlantique/)
- [Fondation Zinsou — informations pratiques](https://www.fondation-zinsou.org/en/infospratiques)
- [OpenStreetMap](https://www.openstreetmap.org/copyright)

## Structure

- `index.html` — application et éléments partagés
- `styles.css`, `app-extras.css` — direction artistique responsive
- `app.js` — contenu, navigation et interactions
- `manifest.webmanifest`, `service-worker.js` — installation PWA et cache hors connexion
- `assets/horysa-icon.svg`, `assets/horysa-lagoon.png` — icône et visuel original
- `start-horysa.bat` — lancement local sous Windows
