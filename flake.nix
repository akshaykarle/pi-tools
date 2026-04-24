{
  description = "Pi coding agent extensions — security hardening, and more";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            typescript-language-server
          ];

          shellHook = ''
            echo "pi-tools dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
          '';
        };
      }
    );
}
