// Antarmuka USB untuk Seiko PS-77 → HP/Laptop.
// Board: Arduino Pro Micro / Leonardo (ATmega32U4) — tampil sebagai keyboard HID + USB serial.
//
// Wiring (lewat relay / optocoupler, JANGAN langsung ke rangkaian flash PS-77):
//   kontak output start PS-77 → relay/opto → TRIGGER_PIN dan GND (kontak menutup = start)
//
// Saat kontak menutup:
//   - kirim tombol F9 (mode "USB HID" di aplikasi — jalan di Android via OTG & laptop)
//   - kirim baris "T,<micros>" via serial (mode "USB Serial – data" di aplikasi)
// Baris "#alive" dikirim tiap detik sebagai heartbeat (diabaikan aplikasi).

#include <Keyboard.h>

const uint8_t TRIGGER_PIN = 2;          // pin interrupt (INT1 di Pro Micro)
const uint8_t LED = LED_BUILTIN_RX;
const unsigned long LOCKOUT_MS = 2000;  // abaikan pantulan relay / trigger ganda
const bool SEND_HID = true;
const bool SEND_SERIAL = true;

volatile bool fired = false;
volatile unsigned long firedMicros = 0;
unsigned long lastFireMs = 0;
unsigned long lastBeatMs = 0;

void onEdge() {
  if (!fired) {
    firedMicros = micros();
    fired = true;
  }
}

void setup() {
  pinMode(TRIGGER_PIN, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
  if (SEND_HID) Keyboard.begin();
  attachInterrupt(digitalPinToInterrupt(TRIGGER_PIN), onEdge, FALLING);
}

void loop() {
  if (fired) {
    unsigned long now = millis();
    if (now - lastFireMs >= LOCKOUT_MS) {
      lastFireMs = now;
      // Kirim serial dulu (paling cepat), lalu HID.
      if (SEND_SERIAL && Serial) {
        Serial.print("T,");
        Serial.println(firedMicros);
      }
      if (SEND_HID) {
        Keyboard.press(KEY_F9);
        delay(20);
        Keyboard.releaseAll();
      }
      digitalWrite(LED, LOW);
      delay(100);
      digitalWrite(LED, HIGH);
    }
    noInterrupts();
    fired = false;
    interrupts();
  }

  if (millis() - lastBeatMs >= 1000) {
    lastBeatMs = millis();
    if (SEND_SERIAL && Serial) Serial.println("#alive");
  }
}
