// nine_dna — track-structure simulation in liquid water for Nine Orders.
//
// Follows the dnaphysics example: a water box, one electron per event,
// Geant4-DNA physics (G4EmDNAPhysics_option2 or _option4). Every step is
// written out with its position, energy deposit, global time, track and
// process, so the app can show each interaction and sim/process.py can map
// deposits onto DNA.
//
// Output: binary records (little endian), 40 bytes each:
//   int32 event, int32 track, int32 parent, int32 process,
//   float32 x, y, z [nm], edep [eV], time [ns], ekin_pre [eV]
// process: 0 elastic, 1 electronic excitation, 2 ionisation, 3 vibrational
//          excitation, 4 dissociative attachment, 5 solvation/thermalisation,
//          6 track start (pre-step point of a new track), 7 other.
#include "G4RunManagerFactory.hh"
#include "G4UImanager.hh"
#include "G4VUserDetectorConstruction.hh"
#include "G4VUserPrimaryGeneratorAction.hh"
#include "G4VUserActionInitialization.hh"
#include "G4UserSteppingAction.hh"
#include "G4UserEventAction.hh"
#include "G4VModularPhysicsList.hh"
#include "G4EmDNAPhysics_option2.hh"
#include "G4EmDNAPhysics_option4.hh"
#include "G4ParticleGun.hh"
#include "G4Electron.hh"
#include "G4NistManager.hh"
#include "G4Box.hh"
#include "G4LogicalVolume.hh"
#include "G4PVPlacement.hh"
#include "G4GenericMessenger.hh"
#include "G4SystemOfUnits.hh"
#include "G4Step.hh"
#include "G4Track.hh"
#include "G4VProcess.hh"
#include "G4Event.hh"
#include "G4Threading.hh"
#include <fstream>
#include <vector>

namespace {
struct Config {
  G4String physics = "opt4";
  G4String out = "dna";
  G4double energy = 2 * keV;
  G4ThreeVector start{0, 0, 0};
  G4ThreeVector dir{0, 0, 1};
  G4ThreeVector half{10 * um, 10 * um, 10 * um};
};
Config cfg;

class Detector : public G4VUserDetectorConstruction {
 public:
  G4VPhysicalVolume* Construct() override {
    G4Material* water = G4NistManager::Instance()->FindOrBuildMaterial("G4_WATER");
    auto* s = new G4Box("World", cfg.half.x(), cfg.half.y(), cfg.half.z());
    auto* l = new G4LogicalVolume(s, water, "World");
    return new G4PVPlacement(nullptr, {}, l, "World", nullptr, false, 0);
  }
};

class Physics : public G4VModularPhysicsList {
 public:
  Physics() {
    SetVerboseLevel(0);
    if (cfg.physics == "opt2") RegisterPhysics(new G4EmDNAPhysics_option2());
    else RegisterPhysics(new G4EmDNAPhysics_option4());
  }
};

class Source : public G4VUserPrimaryGeneratorAction {
 public:
  Source() { gun = new G4ParticleGun(1); gun->SetParticleDefinition(G4Electron::Definition()); }
  void GeneratePrimaries(G4Event* ev) override {
    gun->SetParticleEnergy(cfg.energy);
    gun->SetParticlePosition(cfg.start);
    gun->SetParticleMomentumDirection(cfg.dir.unit());
    gun->GeneratePrimaryVertex(ev);
  }
  G4ParticleGun* gun;
};

#pragma pack(push, 1)
struct Rec { int32_t ev, track, parent, proc; float x, y, z, edep, t, ekin; };
#pragma pack(pop)
G4ThreadLocal std::vector<Rec>* recs = nullptr;
G4ThreadLocal std::ofstream* out = nullptr;
G4ThreadLocal int curEvent = 0;

int code(const G4String& n) {
  if (n == "e-_G4DNAElastic") return 0;
  if (n == "e-_G4DNAExcitation") return 1;
  if (n == "e-_G4DNAIonisation") return 2;
  if (n == "e-_G4DNAVibExcitation") return 3;
  if (n == "e-_G4DNAAttachment") return 4;
  if (n == "e-_G4DNAElectronSolvation") return 5;
  return 7;
}

class Stepping : public G4UserSteppingAction {
 public:
  void UserSteppingAction(const G4Step* st) override {
    const G4Track* tr = st->GetTrack();
    if (tr->GetDefinition() != G4Electron::Definition()) return;
    const auto* pre = st->GetPreStepPoint();
    const auto* post = st->GetPostStepPoint();
    if (tr->GetCurrentStepNumber() == 1) {
      const G4ThreeVector p = pre->GetPosition();
      recs->push_back({curEvent, tr->GetTrackID(), tr->GetParentID(), 6, float(p.x() / nm), float(p.y() / nm), float(p.z() / nm), 0.f,
                       float(pre->GetGlobalTime() / ns), float(pre->GetKineticEnergy() / eV)});
    }
    const G4VProcess* pr = post->GetProcessDefinedStep();
    const G4ThreeVector p = post->GetPosition();
    recs->push_back({curEvent, tr->GetTrackID(), tr->GetParentID(), pr ? code(pr->GetProcessName()) : 7, float(p.x() / nm), float(p.y() / nm),
                     float(p.z() / nm), float(st->GetTotalEnergyDeposit() / eV), float(post->GetGlobalTime() / ns),
                     float(pre->GetKineticEnergy() / eV)});
  }
};

class EventAct : public G4UserEventAction {
 public:
  void BeginOfEventAction(const G4Event* ev) override {
    if (!recs) {
      recs = new std::vector<Rec>();
      out = new std::ofstream(cfg.out + "_t" + std::to_string(G4Threading::G4GetThreadId()) + ".bin", std::ios::binary);
    }
    curEvent = ev->GetEventID();
    recs->clear();
  }
  void EndOfEventAction(const G4Event*) override {
    out->write(reinterpret_cast<const char*>(recs->data()), recs->size() * sizeof(Rec));
    out->flush();
  }
};

class Actions : public G4VUserActionInitialization {
 public:
  void BuildForMaster() const override {}
  void Build() const override {
    SetUserAction(new Source());
    SetUserAction(new Stepping());
    SetUserAction(new EventAct());
  }
};

class Messenger {
 public:
  Messenger() {
    m = new G4GenericMessenger(this, "/nine/", "Nine Orders DNA-scale settings");
    m->DeclareProperty("physics", cfg.physics, "opt2 or opt4");
    m->DeclareProperty("out", cfg.out);
    m->DeclarePropertyWithUnit("energy", "keV", cfg.energy);
    m->DeclarePropertyWithUnit("start", "nm", cfg.start);
    m->DeclareProperty("dir", cfg.dir);
    m->DeclarePropertyWithUnit("half", "um", cfg.half);
    m->DeclareMethod("init", &Messenger::init);
  }
  void init() {
    auto* rm = G4RunManager::GetRunManager();
    rm->SetUserInitialization(new Detector());
    rm->SetUserInitialization(new Physics());
    rm->SetUserInitialization(new Actions());
  }
  G4GenericMessenger* m;
};
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) { G4cerr << "usage: nine_dna macro.mac" << G4endl; return 1; }
  auto* rm = G4RunManagerFactory::CreateRunManager(G4RunManagerType::Default);
  Messenger msg;
  G4UImanager::GetUIpointer()->ApplyCommand("/control/execute " + G4String(argv[1]));
  delete rm;
  return 0;
}
