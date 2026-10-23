# Gemini Conversation Exporter

Script Tampermonkey qui exporte les conversations Google Gemini en Markdown, une à une ou par lot.

Dérivé du [Gemini Conversation Exporter](https://github.com/dikelps/gemini-conversation-exporter) de dikelps, sous licence MIT.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/).
2. Ouvrir [le script brut](https://raw.githubusercontent.com/tribaud/gemini-exporter/master/gemini-conversation-exporter.user.js) : Tampermonkey propose de l'installer.

Les mises à jour arrivent ensuite par Tampermonkey.

## Utilisation

- **Une conversation** : ouvrir la conversation, cliquer sur « Export Markdown » en bas à droite.
- **Plusieurs conversations** : ouvrir la barre latérale de Gemini, puis ⋮ → « Export several conversations… ». La liste se charge par 50. On coche, on exporte, une barre de progression suit l'avancement. Les fichiers arrivent dans un ZIP.

Le script lit l'historique par l'API interne de Gemini, sans cliquer dans la page. Cette API n'est pas documentée et peut changer.

## Options

| Option | Effet |
|---|---|
| Conversation outline | Sommaire des échanges en tête du fichier |
| Export metadata | Source, date, identifiants des échanges, empreinte de validation |
| Tolerant export | Exporte même quand un échange n'a pas de texte (image, Canvas…), avec un avertissement |

Les sessions vocales Gemini Live sont reconnues : leurs échanges vides (Gemini qui parle en premier, réponse interrompue) deviennent des notes, pas des erreurs.

## En cas d'échec

La cause s'affiche dans la liste, au survol. La console (F12) donne le détail, et le bouton « Error report » télécharge un rapport JSON. Ce rapport contient des extraits tronqués des messages : le relire avant de le partager.
