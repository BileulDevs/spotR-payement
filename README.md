# SpotR-Payment  
Microservice de gestion des paiements pour SpotR

## 📌 Description  
**SpotR-Payment** est le microservice responsable de la gestion des transactions financières sur le "réseau social" **SpotR**.  
Il utilise **Stripe** pour offrir des paiements sécurisés, gérer les abonnements et traiter les éventuels remboursements.  

Les principaux objectifs :  
- Gérer les paiements uniques et récurrents.  
- Assurer la sécurité et la conformité des transactions.  
- Faciliter l’intégration avec l’interface front-end et les autres microservices.  
- Fournir des informations de facturation aux utilisateurs.  

---

## ⚙️ Fonctionnalités  
- 💳 **Paiements sécurisés** : traitement des paiements via Stripe.  
- 🔄 **Abonnements récurrents** : gestion des plans d’abonnement SpotR Premium.  
- 📜 **Facturation** : génération et envoi automatique de factures.
- 📡 **API REST** : endpoints sécurisés pour initier et suivre les paiements.  

---

## 🛠️ Stack technique  
- **Langage** : JavaScript  
- **Framework API** : Express.js  
- **Passerelle de paiement** : Stripe API  
- **Sécurité** : Webhooks Stripe sécurisés + validation côté serveur 

---

## 🚀 Changelog  

### 1. Version 1 (v1.0.0)
- Intégration de Stripe Checkout  
- Création d’endpoints pour paiements uniques et abonnements  
- Gestion des webhooks Stripe pour validation et suivi des transactions  
