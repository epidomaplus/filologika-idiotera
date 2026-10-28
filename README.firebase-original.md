# Διαχείριση Ιδιαιτέρων - Φιλόλογος (Cloud Version)

Εφαρμογή με **εγγραφή λογαριασμού** και αποθήκευση στο cloud (Firebase).

## Τι χρειάζεται

1. Δωρεάν λογαριασμός Google
2. Δημιουργία project στο Firebase (δωρεάν)
3. Ανέβασμα των αρχείων σε Firebase Hosting (ή Netlify / Vercel)

## Βήματα Setup (5-10 λεπτά)

### 1. Δημιούργησε Firebase Project
1. Πήγαινε στο [console.firebase.google.com](https://console.firebase.google.com)
2. Πάτα **Add project** → δώσε όνομα (π.χ. `filologika-idiotera`)
3. Απενεργοποίησε το Google Analytics (δεν χρειάζεται) → Create project

### 2. Ενεργοποίησε Authentication
1. Στο αριστερό μενού → **Authentication** → Get started
2. Πάτα **Email/Password** → Enable → Save

### 3. Ενεργοποίησε Firestore
1. Στο αριστερό μενού → **Firestore Database** → Create database
2. Επίλεξε **Start in test mode** (για αρχή) → Next → Enable

### 4. Πάρε τα στοιχεία config
1. Project Settings (γρανάζι) → **Your apps** → πάτα το `</>` (Web)
2. Δώσε όνομα στην εφαρμογή → Register app
3. Αντίγραψε το `firebaseConfig` object

### 5. Βάλε τα στοιχεία στον κώδικα
Άνοιξε το αρχείο **app.js** και αντικατέστησε το `firebaseConfig` στην αρχή με το δικό σου.

### 6. Ανέβασε το site (Firebase Hosting)
1. Εγκατάστησε Node.js αν δεν το έχεις
2. Στο terminal:
```bash
npm install -g firebase-tools
firebase login
firebase init hosting
```
- Επίλεξε το project σου
- Public directory: `.` (η τρέχουσα)
- Single-page app: No
- Overwrite index.html: No

3. Μετά:
```bash
firebase deploy
```

Θα πάρεις ένα URL όπως: `https://to-onoma-sou.web.app`

---

## Εναλλακτικά (πιο εύκολα)

Μπορείς να ανεβάσεις τα αρχεία (`index.html`, `styles.css`, `app.js`) σε:
- **Netlify** (drag & drop στο netlify.com)
- **Vercel**
- **GitHub Pages**

Αρκεί να έχεις βάλει το σωστό `firebaseConfig` στο `app.js`.

## Σημειώσεις

- Κάθε χρήστης βλέπει **μόνο τα δικά του** δεδομένα.
- Τα δεδομένα αποθηκεύονται στο cloud και δεν χάνονται.
- Στην αρχή το Firestore είναι σε test mode (ανοιχτό). Αργότερα μπορείς να βάλεις κανόνες ασφαλείας.

## Κανόνες Ασφαλείας (προαιρετικά αργότερα)

Στο Firestore → Rules βάλε:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

Μετά από αυτά θα έχεις ένα κανονικό URL όπου οποιος θέλει μπορεί να κάνει εγγραφή και να χρησιμοποιεί την εφαρμογή.