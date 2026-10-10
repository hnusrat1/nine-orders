// nine_patient — patient-scale simulation for Nine Orders.
//
// Geometry: voxelised pelvis (sim/anatomy.py) in air; frame: mm, origin at the
// isocentre, +x patient left, +y anterior (towards the source), +z inferior.
// Source: point X-ray target 1000 mm above the isocentre (gantry 0°), photons
// aimed uniformly over a 100 × 100 mm field at the isocentre plane, energies
// sampled from a 6 MV spectrum file (EGSnrc .spectrum format).
// Physics: G4EmStandardPhysics_option4.
//
// Modes (/nine/mode):
//   story   — keep only events whose primary photon first interacts by Compton
//             scattering within /nine/targetRadius of /nine/target and gives the
//             electron an energy within /nine/eRange; record the photon, the
//             recoil electron and every step of it and its secondaries.
//   fluence — score, inside a sphere at the target, the energy deposited and the
//             track length of electrons set in motion by photons (Compton,
//             photoelectric, pair). Used for "tracks per nucleus per Gy".
//   dose    — energy deposited in every voxel of the phantom (for the dose map
//             shown on the CT-style slices). Voxel-by-voxel navigation, so a
//             step never spans several voxels.
#include "G4RunManagerFactory.hh"
#include "G4UImanager.hh"
#include "G4VUserDetectorConstruction.hh"
#include "G4VUserPrimaryGeneratorAction.hh"
#include "G4VUserActionInitialization.hh"
#include "G4UserSteppingAction.hh"
#include "G4UserTrackingAction.hh"
#include "G4UserEventAction.hh"
#include "G4UserRunAction.hh"
#include "G4UserStackingAction.hh"
#include "G4VModularPhysicsList.hh"
#include "G4EmStandardPhysics_option4.hh"
#include "G4DecayPhysics.hh"
#include "G4ParticleGun.hh"
#include "G4Gamma.hh"
#include "G4Electron.hh"
#include "G4NistManager.hh"
#include "G4Box.hh"
#include "G4LogicalVolume.hh"
#include "G4PVPlacement.hh"
#include "G4PVParameterised.hh"
#include "G4PhantomParameterisation.hh"
#include "G4Region.hh"
#include "G4ProductionCuts.hh"
#include "G4GenericMessenger.hh"
#include "G4SystemOfUnits.hh"
#include "G4Step.hh"
#include "G4Track.hh"
#include "G4VProcess.hh"
#include "G4Event.hh"
#include "G4EventManager.hh"
#include "G4Run.hh"
#include "G4AccumulableManager.hh"
#include "G4Accumulable.hh"
#include "G4Threading.hh"
#include "G4AutoLock.hh"
#include "Randomize.hh"
#include <fstream>
#include <sstream>
#include <atomic>
#include <vector>
#include <map>

namespace {
G4Mutex outMutex = G4MUTEX_INITIALIZER;

struct Config {
  G4String mode = "story";
  G4String voxelBin = "pelvis_vox.bin";
  G4String spectrum = "mohan6.spectrum";
  G4String out = "story";
  G4ThreeVector target{0, 0, 0};
  G4double targetRadius = 15 * mm;
  G4double eMin = 0.3 * MeV, eMax = 1.0 * MeV;
  G4double fluenceRadius = 10 * mm;
  G4int maxSelected = 40;
  G4int nx = 184, ny = 128, nz = 176;
  G4double voxel = 2.5 * mm;
  G4ThreeVector origin{-230 * mm, -150 * mm, -230 * mm};
  G4double sad = 1000 * mm;
  G4double field = 100 * mm;
};
Config cfg;
std::atomic<int> nSelected{0};

class Messenger {
 public:
  Messenger() {
    m = new G4GenericMessenger(this, "/nine/", "Nine Orders settings");
    m->DeclareProperty("mode", cfg.mode);
    m->DeclareProperty("voxelBin", cfg.voxelBin);
    m->DeclareProperty("spectrum", cfg.spectrum);
    m->DeclareProperty("out", cfg.out);
    m->DeclarePropertyWithUnit("target", "mm", cfg.target);
    m->DeclarePropertyWithUnit("targetRadius", "mm", cfg.targetRadius);
    m->DeclarePropertyWithUnit("eMin", "MeV", cfg.eMin);
    m->DeclarePropertyWithUnit("eMax", "MeV", cfg.eMax);
    m->DeclarePropertyWithUnit("fluenceRadius", "mm", cfg.fluenceRadius);
    m->DeclareProperty("maxSelected", cfg.maxSelected);
    m->DeclareProperty("nx", cfg.nx);
    m->DeclareProperty("ny", cfg.ny);
    m->DeclareProperty("nz", cfg.nz);
    m->DeclarePropertyWithUnit("voxel", "mm", cfg.voxel);
    m->DeclarePropertyWithUnit("origin", "mm", cfg.origin);
    m->DeclareMethod("init", &Messenger::init, "Build geometry, physics and actions (after the settings above)");
  }
  void init();
  G4GenericMessenger* m;
};

// ------------------------------------------------------------------ geometry
class Detector : public G4VUserDetectorConstruction {
 public:
  G4VPhysicalVolume* Construct() override {
    auto* nist = G4NistManager::Instance();
    G4Material* air = nist->FindOrBuildMaterial("G4_AIR");
    G4Material* soft = nist->FindOrBuildMaterial("G4_TISSUE_SOFT_ICRP");
    // Whole-bone average: ICRP cortical bone composition at 1.40 g/cm3
    // (cortical shell + trabecular bone and marrow, homogenised over the voxel).
    auto* bone = new G4Material("BONE_AVG_1.40", 1.40 * g / cm3, 1);
    bone->AddMaterial(nist->FindOrBuildMaterial("G4_BONE_CORTICAL_ICRP"), 1.0);
    G4Material* urine = nist->FindOrBuildMaterial("G4_WATER");
    std::vector<G4Material*> mats{air, soft, bone, urine};

    auto* worldS = new G4Box("World", 400 * mm, 1150 * mm, 400 * mm);
    auto* worldL = new G4LogicalVolume(worldS, air, "World");
    auto* worldP = new G4PVPlacement(nullptr, {}, worldL, "World", nullptr, false, 0);

    const G4int n = cfg.nx * cfg.ny * cfg.nz;
    idx = new size_t[n];
    std::ifstream f(cfg.voxelBin, std::ios::binary);
    if (!f) G4Exception("Detector", "vox", FatalException, ("cannot read " + cfg.voxelBin).c_str());
    std::vector<unsigned char> buf(n);
    f.read(reinterpret_cast<char*>(buf.data()), n);
    for (G4int i = 0; i < n; i++) idx[i] = buf[i];

    const G4double hx = cfg.nx * cfg.voxel / 2, hy = cfg.ny * cfg.voxel / 2, hz = cfg.nz * cfg.voxel / 2;
    G4ThreeVector centre = cfg.origin + G4ThreeVector(hx, hy, hz);
    auto* contS = new G4Box("Phantom", hx, hy, hz);
    auto* contL = new G4LogicalVolume(contS, air, "Phantom");
    auto* contP = new G4PVPlacement(nullptr, centre, contL, "Phantom", worldL, false, 0);

    auto* param = new G4PhantomParameterisation();
    param->SetVoxelDimensions(cfg.voxel / 2, cfg.voxel / 2, cfg.voxel / 2);
    param->SetNoVoxels(cfg.nx, cfg.ny, cfg.nz);
    param->SetMaterials(mats);
    param->SetMaterialIndices(idx);
    param->BuildContainerSolid(contP);
    param->CheckVoxelsFillContainer(contS->GetXHalfLength(), contS->GetYHalfLength(), contS->GetZHalfLength());
    auto* voxS = new G4Box("Voxel", cfg.voxel / 2, cfg.voxel / 2, cfg.voxel / 2);
    auto* voxL = new G4LogicalVolume(voxS, soft, "Voxel");
    auto* voxP = new G4PVParameterised("Voxel", voxL, contL, kUndefined, n, param);
    if (cfg.mode != "dose") voxP->SetRegularStructureId(1);  // dose mode: stop at every voxel boundary

    auto* region = new G4Region("phantom");
    region->AddRootLogicalVolume(contL);
    return worldP;
  }
  size_t* idx = nullptr;
};

// ------------------------------------------------------------------ source
class Source : public G4VUserPrimaryGeneratorAction {
 public:
  Source() {
    gun = new G4ParticleGun(1);
    gun->SetParticleDefinition(G4Gamma::Definition());
    std::ifstream f(cfg.spectrum);
    std::string line;
    std::getline(f, line);  // title
    std::getline(f, line);
    for (char& c : line) if (c == ',') c = ' ';
    std::istringstream h(line);
    int nb, mode; double emin;
    h >> nb >> emin >> mode;
    double lo = emin, sum = 0;
    for (int i = 0; i < nb; i++) {
      std::getline(f, line);
      for (char& c : line) if (c == ',') c = ' ';
      std::istringstream s(line);
      double etop, v; s >> etop >> v;
      double w = mode == 1 ? v * (etop - lo) : v;
      edges.push_back(lo); tops.push_back(etop); sum += w; cdf.push_back(sum);
      lo = etop;
    }
    for (auto& c : cdf) c /= sum;
  }
  void GeneratePrimaries(G4Event* ev) override {
    double u = G4UniformRand();
    size_t i = std::lower_bound(cdf.begin(), cdf.end(), u) - cdf.begin();
    double E = edges[i] + G4UniformRand() * (tops[i] - edges[i]);
    G4ThreeVector src(0, cfg.sad, 0);
    G4ThreeVector aim((G4UniformRand() - 0.5) * cfg.field, 0, (G4UniformRand() - 0.5) * cfg.field);
    gun->SetParticleEnergy(E * MeV);
    gun->SetParticlePosition(src);
    gun->SetParticleMomentumDirection((aim - src).unit());
    gun->GeneratePrimaryVertex(ev);
  }
  G4ParticleGun* gun;
  std::vector<double> edges, tops, cdf;
};

// ------------------------------------------------------------------ story recording
struct StoryEvent {
  bool selected = false, entered = false;
  std::ostringstream os;
  G4ThreeVector entry;
};
G4ThreadLocal StoryEvent* story = nullptr;

int procCode(const G4String& n) {
  if (n == "eIoni") return 10;
  if (n == "msc" || n == "Transportation" || n == "CoupledTransportation") return 11;
  if (n == "eBrem") return 12;
  return 13;
}

class Stepping : public G4UserSteppingAction {
 public:
  void UserSteppingAction(const G4Step* st) override {
    if (cfg.mode == "fluence") return fluence(st);
    if (cfg.mode == "dose") return dose(st);
    G4Track* tr = st->GetTrack();
    auto* post = st->GetPostStepPoint();
    const G4VProcess* pr = post->GetProcessDefinedStep();
    G4String pn = pr ? pr->GetProcessName() : "none";
    if (tr->GetTrackID() == 1) {
      if (nSelected.load() >= cfg.maxSelected) { abortEvent(tr); return; }
      if (!story->entered && post->GetMaterial() && post->GetMaterial()->GetName() != "G4_AIR") {
        story->entered = true; story->entry = post->GetPosition();
      }
      if (pn == "Transportation" || pn == "CoupledTransportation" || pn == "Rayl") return;
      // Null steps (sampling rejections) leave the photon unchanged: not an interaction.
      const auto* sec = st->GetSecondaryInCurrentStep();
      if (sec->empty() && tr->GetTrackStatus() == fAlive && post->GetKineticEnergy() == st->GetPreStepPoint()->GetKineticEnergy()) return;
      if (pn != "compt" || (post->GetPosition() - cfg.target).mag() > cfg.targetRadius) { abortEvent(tr); return; }
      const G4Track* e = nullptr;
      for (auto* s : *sec) if (s->GetDefinition() == G4Electron::Definition()) e = s;
      if (!e || e->GetKineticEnergy() < cfg.eMin || e->GetKineticEnergy() > cfg.eMax) { abortEvent(tr); return; }
      // selected: record the interaction, then stop following the scattered photon
      const G4ThreeVector x = post->GetPosition(), din = st->GetPreStepPoint()->GetMomentumDirection(), dout = post->GetMomentumDirection();
      story->selected = true;
      story->os.precision(9);
      story->os << "P " << st->GetPreStepPoint()->GetKineticEnergy() / MeV << ' ' << x.x() << ' ' << x.y() << ' ' << x.z() << ' '
                << din.x() << ' ' << din.y() << ' ' << din.z() << ' ' << post->GetKineticEnergy() / MeV << ' '
                << dout.x() << ' ' << dout.y() << ' ' << dout.z() << ' ' << e->GetKineticEnergy() / MeV << ' '
                << e->GetMomentumDirection().x() << ' ' << e->GetMomentumDirection().y() << ' ' << e->GetMomentumDirection().z() << ' '
                << story->entry.x() << ' ' << story->entry.y() << ' ' << story->entry.z() << ' ' << post->GetGlobalTime() / ns << '\n';
      tr->SetTrackStatus(fStopAndKill);
      return;
    }
    if (!story->selected) return;
    if (tr->GetDefinition() != G4Electron::Definition()) { tr->SetTrackStatus(fStopAndKill); return; }
    if (tr->GetCurrentStepNumber() == 1) {
      const auto* pre = st->GetPreStepPoint();
      const G4ThreeVector p = pre->GetPosition(), d = pre->GetMomentumDirection();
      const G4VProcess* cp = tr->GetCreatorProcess();
      story->os << "T " << tr->GetTrackID() << ' ' << tr->GetParentID() << ' ' << (cp ? cp->GetProcessName() : G4String("primary")) << ' '
                << pre->GetKineticEnergy() / keV << ' ' << p.x() << ' ' << p.y() << ' ' << p.z() << ' '
                << d.x() << ' ' << d.y() << ' ' << d.z() << ' ' << pre->GetGlobalTime() / ns << '\n';
    }
    const G4ThreeVector p = post->GetPosition();
    story->os << "S " << tr->GetTrackID() << ' ' << p.x() << ' ' << p.y() << ' ' << p.z() << ' ' << st->GetTotalEnergyDeposit() / keV << ' '
              << post->GetKineticEnergy() / keV << ' ' << post->GetGlobalTime() / ns << ' ' << procCode(pn) << ' '
              << post->GetMaterial()->GetName() << ' ' << st->GetStepLength() / mm << '\n';
  }

  void abortEvent(G4Track* tr) {
    tr->SetTrackStatus(fStopAndKill);
    G4EventManager::GetEventManager()->AbortCurrentEvent();
  }

  // --- fluence / dose scoring
  void fluence(const G4Step* st);
  void dose(const G4Step* st);
};

// per-thread energy deposit per voxel (MeV), summed into doseTotal at the end of the run
G4ThreadLocal std::vector<double>* doseBuf = nullptr;
std::vector<double> doseTotal;

void Stepping::dose(const G4Step* st) {
  const G4double e = st->GetTotalEnergyDeposit();
  if (e <= 0) return;
  const G4VTouchable* th = st->GetPreStepPoint()->GetTouchable();
  if (!th->GetVolume() || th->GetVolume()->GetName() != "Voxel") return;
  if (!doseBuf) doseBuf = new std::vector<double>(size_t(cfg.nx) * cfg.ny * cfg.nz, 0.0);
  (*doseBuf)[th->GetReplicaNumber(0)] += e / MeV;
}

struct Scores {
  G4Accumulable<G4double> edep{"edep", 0.}, lenPrimaryE{"lenPrimaryE", 0.}, lenAllE{"lenAllE", 0.};
  G4Accumulable<G4int> nPrimE{"nPrimE", 0};
};
G4ThreadLocal Scores* scores = nullptr;

void Stepping::fluence(const G4Step* st) {
  const G4ThreeVector a = st->GetPreStepPoint()->GetPosition(), b = st->GetPostStepPoint()->GetPosition();
  const G4ThreeVector mid = 0.5 * (a + b);
  G4Track* tr = st->GetTrack();
  const bool isE = tr->GetDefinition() == G4Electron::Definition();
  // electrons that cannot reach the sphere are not followed (CSDA range < 0.6 cm/MeV · E in tissue)
  if (isE && tr->GetCurrentStepNumber() == 1) {
    double reach = cfg.fluenceRadius + 6.0 * mm * (st->GetPreStepPoint()->GetKineticEnergy() / MeV) + 2 * mm;
    if ((a - cfg.target).mag() > reach) { tr->SetTrackStatus(fStopAndKill); return; }
  }
  if ((mid - cfg.target).mag() > cfg.fluenceRadius) return;
  scores->edep += st->GetTotalEnergyDeposit();
  if (isE) {
    scores->lenAllE += st->GetStepLength();
    const G4VProcess* cp = tr->GetCreatorProcess();
    if (cp) {
      const G4String& n = cp->GetProcessName();
      if (n == "compt" || n == "phot" || n == "conv") {
        scores->lenPrimaryE += st->GetStepLength();
        if (tr->GetCurrentStepNumber() == 1) scores->nPrimE += 1;
      }
    }
  }
}

class Tracking : public G4UserTrackingAction {};

class EventAct : public G4UserEventAction {
 public:
  void BeginOfEventAction(const G4Event*) override {
    if (!story) story = new StoryEvent();
    story->selected = false; story->entered = false; story->os.str(""); story->os.clear();
  }
  void EndOfEventAction(const G4Event* ev) override {
    if (cfg.mode != "story" || !story->selected || ev->IsAborted()) return;
    int k = ++nSelected;
    if (k > cfg.maxSelected) return;
    G4AutoLock l(&outMutex);
    std::ofstream o(cfg.out + ".txt", std::ios::app);
    o << "E " << ev->GetEventID() << ' ' << G4Threading::G4GetThreadId() << '\n' << story->os.str() << "EE\n";
  }
};

class RunAct : public G4UserRunAction {
 public:
  RunAct() {
    scores = &sc;
    auto* m = G4AccumulableManager::Instance();
    m->Register(sc.edep); m->Register(sc.lenPrimaryE); m->Register(sc.lenAllE); m->Register(sc.nPrimE);
  }
  Scores sc;
  void BeginOfRunAction(const G4Run*) override { G4AccumulableManager::Instance()->Reset(); }
  void EndOfRunAction(const G4Run* run) override {
    G4AccumulableManager::Instance()->Merge();
    if (cfg.mode == "dose") {
      if (!IsMaster()) {
        if (!doseBuf) return;
        G4AutoLock l(&outMutex);
        if (doseTotal.empty()) doseTotal.assign(doseBuf->size(), 0.0);
        for (size_t i = 0; i < doseBuf->size(); i++) doseTotal[i] += (*doseBuf)[i];
        return;
      }
      std::vector<float> f(doseTotal.begin(), doseTotal.end());
      std::ofstream b(cfg.out + ".bin", std::ios::binary);
      b.write(reinterpret_cast<const char*>(f.data()), f.size() * sizeof(float));
      std::ofstream o(cfg.out + ".json");
      o << "{\"events\": " << run->GetNumberOfEvent() << ", \"n\": [" << cfg.nx << ", " << cfg.ny << ", " << cfg.nz
        << "], \"voxel_mm\": " << cfg.voxel / mm << ", \"units\": \"MeV deposited per voxel, float32, copyNo order\"}\n";
      G4cout << "dose results written to " << cfg.out << ".bin" << G4endl;
      return;
    }
    if (!IsMaster() || cfg.mode != "fluence") return;
    std::ofstream o(cfg.out + ".json");
    o.precision(10);
    o << "{\"events\": " << run->GetNumberOfEvent() << ", \"radius_mm\": " << cfg.fluenceRadius / mm
      << ", \"target_mm\": [" << cfg.target.x() << ", " << cfg.target.y() << ", " << cfg.target.z() << "]"
      << ", \"edep_MeV\": " << sc.edep.GetValue() / MeV << ", \"lenPrimaryE_mm\": " << sc.lenPrimaryE.GetValue() / mm
      << ", \"lenAllE_mm\": " << sc.lenAllE.GetValue() / mm << ", \"nPrimaryElectronsStarted\": " << sc.nPrimE.GetValue() << "}\n";
    G4cout << "fluence results written to " << cfg.out << ".json" << G4endl;
  }
};

class Actions : public G4VUserActionInitialization {
 public:
  void BuildForMaster() const override { SetUserAction(new RunAct()); }
  void Build() const override {
    SetUserAction(new Source());
    SetUserAction(new Stepping());
    SetUserAction(new EventAct());
    SetUserAction(new RunAct());
  }
};

class Physics : public G4VModularPhysicsList {
 public:
  Physics() {
    SetVerboseLevel(0);
    RegisterPhysics(new G4EmStandardPhysics_option4());
    RegisterPhysics(new G4DecayPhysics());
  }
};

void Messenger::init() {
  auto* rm = G4RunManager::GetRunManager();
  rm->SetUserInitialization(new Detector());
  rm->SetUserInitialization(new Physics());
  rm->SetUserInitialization(new Actions());
}
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) { G4cerr << "usage: nine_patient macro.mac" << G4endl; return 1; }
  auto* rm = G4RunManagerFactory::CreateRunManager(G4RunManagerType::Default);
  Messenger msg;
  G4UImanager::GetUIpointer()->ApplyCommand("/control/execute " + G4String(argv[1]));
  delete rm;
  return 0;
}
